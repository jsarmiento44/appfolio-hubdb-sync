const axios = require("axios");
require("dotenv").config();

// Load environment variables
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
    description: listing.marketing_description || "",
    title: listing.marketing_title || "",
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
        headers: {
          "Content-Type": "application/json",
        },
      }
    );

    const rawListings = response.data.results || [];

    const activeListings = rawListings.filter(
      (l) =>
        l.unit_visibility?.toLowerCase() === "active" ||
        l.visibility?.toLowerCase() === "active"
    );

    const internetListings = activeListings.filter(
      (l) => l.posted_to_internet?.toLowerCase() === "yes"
    );

    console.log("🧪 Listing keys example:", Object.keys(rawListings[0] || {}));
    console.log(
      "🧪 Sample listing posted_to_internet value:",
      rawListings[0]?.posted_to_internet
    );

    console.log(`📦 Fetched ${activeListings.length} active listings`);
    console.log(`📦 Syncing ${internetListings.length} listings posted to internet...`);

    return { activeListings, internetListings };
  } catch (error) {
    console.error(
      "❌ AppFolio fetch error:",
      error.response?.status,
      error.response?.data || error.message
    );
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

async function upsertHubDBRow(listing, tableId, isPublic = false) {
  const formatted = formatRow(listing);
  const address = formatted.address;
  const headers = {
    Authorization: `Bearer ${HUBSPOT_API_KEY}`,
    "Content-Type": "application/json",
  };
  const rowUrl = `https://api.hubapi.com/cms/v3/hubdb/tables/${tableId}/rows`;
  const existingRowId = await findExistingRowByAddress(address, tableId);
  const payload = { values: formatted };

  try {
    if (existingRowId) {
      try {
        await axios.patch(`${rowUrl}/${existingRowId}/draft`, payload, { headers });
        console.log(`🔄 Updated (${tableId}): ${formatted.name}`);
      } catch (patchErr) {
        if (patchErr.response?.status === 405) {
          console.warn(`⚠️ Draft patch blocked by 405 — creating draft for ${formatted.name}`);
          await axios.put(`${rowUrl}/${existingRowId}/draft`, {}, { headers });
          await axios.patch(`${rowUrl}/${existingRowId}/draft`, payload, { headers });
          console.log(`♻️ Updated after draft creation: ${formatted.name}`);
        } else {
          throw patchErr;
        }
      }
    } else {
      await axios.post(`${rowUrl}/draft`, payload, { headers });
      console.log(`✅ Created (${tableId}): ${formatted.name}`);
    }
  } catch (error) {
    const status = error.response?.status;
    const message = error.response?.data?.message || error.message;
    console.error(`❌ Sync error for ${formatted.name} (${tableId}): ${status} - ${message}`);
    console.log("🪪 Listing debug dump:", JSON.stringify(formatted, null, 2));
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
    console.error(`❌ Failed to push live (${tableId}):`, error.response?.data || error.message);
  }
}

(async function syncListings() {
  console.log("🚀 Starting sync script...");
  const { activeListings, internetListings } = await fetchAppFolioData();

  if (!activeListings.length) {
    console.log("⚠️ No listings found to sync.");
    return;
  }

  for (const listing of activeListings) {
    await upsertHubDBRow(listing, HUBDB_TABLE_ID);
  }

  for (const listing of internetListings) {
    if (!listing.marketing_title || !listing.marketing_description) {
      console.warn(`⛔ Skipping public row: ${listing.unit_address} — missing title or description.`);
      continue;
    }
    await upsertHubDBRow(listing, HUBDB_TABLE_ID_PUBLIC, true);
  }

  await pushLiveChanges(HUBDB_TABLE_ID);
  await pushLiveChanges(HUBDB_TABLE_ID_PUBLIC);
  console.log("✅ Sync complete.");
})();
