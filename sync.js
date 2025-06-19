// ✅ FINAL SYNC SCRIPT WITH PUBLIC TABLE 405 PATCH

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
console.log("🏠 HUBDB_TABLE_ID (Internal):", HUBDB_TABLE_ID);
console.log("🌐 HUBDB_TABLE_ID_PUBLIC:", HUBDB_TABLE_ID_PUBLIC);

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
    utilities: listing.unit_utilities || "",
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

const failedListings = [];

async function findExistingRowByAddress(address, tableId) {
  try {
    const res = await axios.get(
      `https://api.hubapi.com/cms/v3/hubdb/tables/${tableId}/rows`,
      {
        headers: {
          Authorization: `Bearer ${HUBSPOT_API_KEY}`,
          "Content-Type": "application/json",
        },
      }
    );
    const normalized = address.trim().toLowerCase();
    return res.data.results.find(
      (row) => row.values?.address?.trim().toLowerCase() === normalized
    )?.id || null;
  } catch (err) {
    return null;
  }
}

async function upsertHubDBRow(listing, tableId) {
  const formatted = formatRow(listing);

  if (!formatted.title || formatted.rent === 0) {
    console.warn(`⚠️ Skipping: Missing title or rent = 0 – ${formatted.name}`);
    return;
  }

  const isPublicTable = tableId === HUBDB_TABLE_ID_PUBLIC;
  const label = isPublicTable ? '🌐 PUBLIC' : '🏠 INTERNAL';

  const headers = {
    Authorization: `Bearer ${HUBSPOT_API_KEY}`,
    "Content-Type": "application/json",
  };

  const rowUrl = `https://api.hubapi.com/cms/v3/hubdb/tables/${tableId}/rows`;
  const existingId = await findExistingRowByAddress(formatted.address, tableId);
  const payload = { values: formatted };

  try {
    if (existingId) {
      try {
        await axios.put(`${rowUrl}/${existingId}/draft`, {}, { headers });
        await axios.patch(`${rowUrl}/${existingId}/draft`, payload, { headers });
        console.log(`🔄 Updated (${label}): ${formatted.name}`);
      } catch (err) {
        if ([400, 405].includes(err.response?.status)) {
          console.warn(`♻️ Recreating due to error ${err.response?.status} (${label}): ${formatted.name}`);
          await axios.delete(`${rowUrl}/${existingId}`, { headers });

          if (isPublicTable) {
            await axios.post(`${rowUrl}`, payload, { headers });
            console.log(`✅ Recreated LIVE (${label}): ${formatted.name}`);
          } else {
            await axios.post(`${rowUrl}/draft`, payload, { headers });
            console.log(`✅ Recreated DRAFT (${label}): ${formatted.name}`);
          }
        } else {
          failedListings.push(formatted.name);
          console.error(`❌ Failed to update (${label}): ${formatted.name}`);
          console.error(err.response?.data || err.message);
        }
      }
    } else {
      await axios.post(`${rowUrl}/draft`, payload, { headers });
      console.log(`✅ Created (${label}): ${formatted.name}`);
    }
  } catch (err) {
    failedListings.push(formatted.name);
    console.error(`❌ Final error syncing (${label}): ${formatted.name}`);
    console.error(`🔍 Error Message:`, err.response?.data || err.message);
    console.log(`📄 Payload Attempted:`, JSON.stringify(payload, null, 2));
    console.log(`📍 Table ID: ${tableId}`);
    console.log(`📬 Endpoint: ${existingId ? `${rowUrl}/${existingId}/draft` : `${rowUrl}/draft`}`);
  }
}

async function pushLiveChanges(tableId) {
  try {
    await axios.post(
      `https://api.hubapi.com/cms/v3/hubdb/tables/${tableId}/draft/push-live`,
      {},
      {
        headers: {
          Authorization: `Bearer ${HUBSPOT_API_KEY}`,
          "Content-Type": "application/json",
        },
      }
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

  console.log(`🛠 Syncing INTERNAL listings to table: ${HUBDB_TABLE_ID}`);
  for (const listing of activeListings) {
    await upsertHubDBRow(listing, HUBDB_TABLE_ID);
  }

  console.log(`🌐 Syncing PUBLIC listings to table: ${HUBDB_TABLE_ID_PUBLIC}`);
  for (const listing of internetListings) {
    console.log("🧾 Checking listing:", {
      title: listing.marketing_title,
      rent: listing.advertised_rent,
      address: listing.unit_address,
    });
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
