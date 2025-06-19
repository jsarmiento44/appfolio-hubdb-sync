const axios = require("axios");
require("dotenv").config();

const {
  APPFOLIO_CLIENT_ID,
  APPFOLIO_CLIENT_SECRET,
  APPFOLIO_DOMAIN,
  HUBSPOT_API_KEY,
  HUBDB_TABLE_ID,
  HUBDB_TABLE_ID_PUBLIC,
} = process.env;

if (
  !APPFOLIO_CLIENT_ID ||
  !APPFOLIO_CLIENT_SECRET ||
  !APPFOLIO_DOMAIN ||
  !HUBSPOT_API_KEY ||
  !HUBDB_TABLE_ID ||
  !HUBDB_TABLE_ID_PUBLIC
) {
  console.error("❌ Missing required environment variables.");
  process.exit(1);
}

console.log("🔑 HUBSPOT_API_KEY:", !!HUBSPOT_API_KEY);
console.log("✅ APPFOLIO_CLIENT_ID:", APPFOLIO_CLIENT_ID?.slice(0, 8));
console.log("📦 HUBDB_TABLE_ID (Internal):", HUBDB_TABLE_ID);
console.log("📦 HUBDB_TABLE_ID_PUBLIC:", HUBDB_TABLE_ID_PUBLIC);

const APPFOLIO_URL = `https://${APPFOLIO_DOMAIN}.appfolio.com/api/v2/reports/unit_directory.json`;

function generateSlug(listing) {
  const base = listing.unit_address || listing.property_name || "untitled";
  return base
    .toLowerCase()
    .replace(/[^\x20-\x7E]/g, "")
    .replace(/[\s\/\\]+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/--+/g, "-")
    .trim();
}

function autoGenerateMeta(description, city) {
  if (!description && !city) return "";
  return `Discover this rental in ${city || "California"} — ${
    description?.slice(0, 100) || ""
  }...`;
}

function formatRow(listing) {
  return {
    name: listing.unit_address || listing.unit_name || "Untitled Listing",
    slug: generateSlug(listing),
    property_name: listing.property_name || "",
    address: listing.unit_address || "",
    city: listing.unit_city || "",
    state: listing.unit_state || "",
    zip: listing.unit_zip || "",
    sqft: listing.sqft || null,
    bedrooms: listing.bedrooms || null,
    bathrooms: listing.bathrooms ? parseFloat(listing.bathrooms) : null,
    rent: listing.advertised_rent ? parseFloat(listing.advertised_rent) : null,
    deposit: listing.default_deposit || null,
    description: listing.marketing_description || "No description available",
    title: listing.marketing_title || "Untitled Listing",
    youtube_url: listing.you_tube_url || "",
    application_fee: listing.application_fee
      ? parseFloat(listing.application_fee)
      : null,
    amenities: listing.unit_amenities || "",
    appliances: listing.unit_appliances || "",
    billed_as: listing.billed_as || "",
    meta_description: autoGenerateMeta(
      listing.marketing_description,
      listing.unit_city
    ),
  };
}

async function fetchAppFolioData() {
  try {
    const response = await axios.post(
      APPFOLIO_URL,
      {},
      {
        auth: {
          username: APPFOLIO_CLIENT_ID,
          password: APPFOLIO_CLIENT_SECRET,
        },
        headers: { "Content-Type": "application/json" },
      }
    );

    const rawListings = response.data.results || [];

    const activeListings = rawListings.filter(
      (l) =>
        l.unit_visibility?.toLowerCase() === "active" ||
        l.visibility?.toLowerCase() === "active"
    );

    const internetListings = activeListings.filter(
      (l) =>
        l.posted_to_internet?.toString().toLowerCase() === "yes" ||
        l.posted_to_internet === true
    );

    console.log("🧪 Sample fields:", Object.keys(rawListings[0] || {}));
    console.log(`📦 Active listings: ${activeListings.length}`);
    console.log(`📤 Internet-posted listings: ${internetListings.length}`);

    return { activeListings, internetListings };
  } catch (error) {
    console.error("❌ AppFolio fetch error:", error.response?.status, error.response?.data || error.message);
    return { activeListings: [], internetListings: [] };
  }
}

async function findExistingRowByAddress(address, tableId) {
  const url = `https://api.hubapi.com/cms/v3/hubdb/tables/${tableId}/rows`;
  try {
    const response = await axios.get(url, {
      headers: {
        Authorization: `Bearer ${HUBSPOT_API_KEY}`,
        "Content-Type": "application/json",
      },
    });
    const normalized = address.trim().toLowerCase();
    const match = response.data.results.find(
      (row) => row.values?.address?.trim().toLowerCase() === normalized
    );
    return match?.id || null;
  } catch (error) {
    console.error(`❌ Error searching HubDB table (${tableId}):`, error.message);
    return null;
  }
}

const failedListings = [];

async function upsertHubDBRow(listing, tableId) {
  const formatted = formatRow(listing);

  if (!formatted.title || formatted.rent === 0) {
    console.warn(`⚠️ Skipping: Missing title or rent = 0 – ${formatted.name}`);
    return;
  }

  const headers = {
    Authorization: `Bearer ${HUBSPOT_API_KEY}`,
    "Content-Type": "application/json",
  };
  const rowUrl = `https://api.hubapi.com/cms/v3/hubdb/tables/${tableId}/rows`;
  const existingRowId = await findExistingRowByAddress(formatted.address, tableId);
  const payload = { values: formatted };

  try {
    if (existingRowId) {
      try {
        console.log(`✏️ PUT draft for row ${existingRowId}`);
        await axios.put(`${rowUrl}/${existingRowId}/draft`, {}, { headers });

        console.log(`✏️ PATCH draft for row ${existingRowId}`);
        await axios.patch(`${rowUrl}/${existingRowId}/draft`, payload, { headers });

        console.log(`🔄 Updated (${tableId}): ${formatted.name}`);
      } catch (updateErr) {
        const status = updateErr.response?.status;
        const body = updateErr.response?.data;
        console.error(`❌ PATCH failed (${tableId}) – ${formatted.name}: ${status}`);
        console.log("🔍 Full error:", JSON.stringify(body, null, 2));

        if (status === 405 || status === 400) {
          try {
            await axios.delete(`${rowUrl}/${existingRowId}`, { headers });
            console.log(`🗑️ Deleted row ${existingRowId}`);
            await axios.post(`${rowUrl}/draft`, payload, { headers });
            console.log(`♻️ Recreated row (${tableId}): ${formatted.name}`);
          } catch (fallbackErr) {
            console.error(`💥 Fallback failed (${formatted.name}): ${fallbackErr.response?.status}`);
            console.log("📄 Final payload:", JSON.stringify(payload.values, null, 2));
            failedListings.push(formatted.name);
          }
        }
      }
    } else {
      await axios.post(`${rowUrl}/draft`, payload, { headers });
      console.log(`✅ Created (${tableId}): ${formatted.name}`);
    }
  } catch (finalErr) {
    const status = finalErr.response?.status;
    const message = finalErr.response?.data?.message || finalErr.message;
    console.error(`❌ Final sync error (${formatted.name}) – ${status}: ${message}`);
    console.log("🪪 Full listing dump:", JSON.stringify(formatted, null, 2));

    if ((status === 405 || status === 400) && existingRowId) {
      try {
        await axios.delete(`${rowUrl}/${existingRowId}`, { headers });
        console.log(`🧹 Deleted row ${existingRowId} due to persistent 405`);
        await axios.post(`${rowUrl}/draft`, payload, { headers });
        console.log(`♻️ Recreated row (final fallback): ${formatted.name}`);
      } catch (forceErr) {
        console.error(`🛑 Fallback-recreate also failed:`, forceErr.response?.status);
        console.log("❌ Failed row data:", JSON.stringify(payload.values, null, 2));
        failedListings.push(formatted.name);
      }
    } else {
      failedListings.push(formatted.name);
    }
  }
}

async function pushLiveChanges(tableId) {
  if (!tableId) return;
  try {
    const headers = {
      Authorization: `Bearer ${HUBSPOT_API_KEY}`,
      "Content-Type": "application/json",
    };
    await axios.post(
      `https://api.hubapi.com/cms/v3/hubdb/tables/${tableId}/draft/push-live`,
      {},
      { headers }
    );
    console.log(`🚀 Pushed draft rows live for table ${tableId}`);
  } catch (error) {
    console.error(`❌ Push live failed (${tableId}):`, error.response?.data || error.message);
  }
}

(async function syncListings() {
  console.log("🚀 Starting sync...");
  const { activeListings, internetListings } = await fetchAppFolioData();

  if (!activeListings.length) {
    console.log("⚠️ No active listings found.");
    return;
  }

  for (const listing of activeListings) {
    await upsertHubDBRow(listing, HUBDB_TABLE_ID);
  }

  for (const listing of internetListings) {
    await upsertHubDBRow(listing, HUBDB_TABLE_ID_PUBLIC);
  }

  await pushLiveChanges(HUBDB_TABLE_ID);
  await pushLiveChanges(HUBDB_TABLE_ID_PUBLIC);

  console.log("✅ Sync complete.");
  if (failedListings.length) {
    console.warn("❌ Listings that failed after all retries:");
    failedListings.forEach((name) => console.warn(" -", name));
  }
})();
