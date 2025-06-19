require("dotenv").config();
const axios = require("axios");

const HUBSPOT_API_KEY = process.env.HUBSPOT_API_KEY;
const HUBDB_TABLE_ID_INTERNAL = process.env.HUBDB_TABLE_ID_INTERNAL;
const APPFOLIO_CLIENT_ID = process.env.APPFOLIO_CLIENT_ID;
const APPFOLIO_CLIENT_SECRET = process.env.APPFOLIO_CLIENT_SECRET;
const APPFOLIO_DOMAIN = process.env.APPFOLIO_DOMAIN;
const APPFOLIO_REPORT_NAME = process.env.APPFOLIO_REPORT_NAME;

if (!HUBSPOT_API_KEY || !APPFOLIO_CLIENT_ID || !APPFOLIO_CLIENT_SECRET || !APPFOLIO_DOMAIN || !APPFOLIO_REPORT_NAME || !HUBDB_TABLE_ID_INTERNAL) {
  console.error("❌ Missing required environment variables.");
  process.exit(1);
}

console.log("🔑 HUBSPOT_API_KEY:", !!HUBSPOT_API_KEY);
console.log("✅ APPFOLIO_CLIENT_ID:", APPFOLIO_CLIENT_ID);
console.log("📦 HUBDB_TABLE_ID (Internal):", HUBDB_TABLE_ID_INTERNAL);
console.log("🚀 Starting sync script...");

const headers = {
  Authorization: `Bearer ${HUBSPOT_API_KEY}`,
  "Content-Type": "application/json",
};

async function fetchAppFolioListings() {
  const url = `https://${APPFOLIO_CLIENT_ID}:${APPFOLIO_CLIENT_SECRET}@${APPFOLIO_DOMAIN}.appfolio.com/api/v2/reports/${APPFOLIO_REPORT_NAME}.json`;

  try {
    const response = await axios.post(url, {}, {
      headers: { "Content-Type": "application/json" }
    });
    return response.data.rows;
  } catch (err) {
    console.error("❌ AppFolio fetch error:", err.response?.status, err.response?.data || err.message);
    return [];
  }
}

function formatListing(row) {
  return {
    name: row["Marketing Title"] || row["Unit Address"],
    address: row["Unit Address"],
    city: row["City"],
    state: row["State"],
    zip: row["Zip Code"],
    rent: row["Advertised Rent"],
    beds: row["Bedrooms"],
    baths: row["Bathrooms"],
    sqft: row["Square Feet"],
    applicationFee: row["Application Fee"],
    amenities: row["Unit Amenities"],
    slug: row["Marketing Title"]?.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, ""),
  };
}

async function findExistingRowByAddress(address, tableId) {
  const res = await axios.get(
    `https://api.hubapi.com/cms/v3/hubdb/tables/${tableId}/rows?hapikey=${HUBSPOT_API_KEY}`
  );
  const match = res.data.results.find(row => row.values?.address === address);
  return match?.id;
}

async function upsertHubDBRow(formatted, tableId) {
  const payload = {
    values: {
      name: formatted.name,
      address: formatted.address,
      city: formatted.city,
      state: formatted.state,
      zip: formatted.zip,
      rent: formatted.rent,
      beds: formatted.beds,
      baths: formatted.baths,
      sqft: formatted.sqft,
      application_fee: formatted.applicationFee,
      amenities: formatted.amenities,
      slug: formatted.slug,
    }
  };

  try {
    await axios.post(
      `https://api.hubapi.com/cms/v3/hubdb/tables/${tableId}/rows`,
      payload,
      { headers }
    );
    console.log(`🔄 Updated (POST): ${formatted.name}`);
  } catch (postError) {
    if (postError.response?.status === 405) {
      console.warn(`⚠️ POST failed with 405, retrying PATCH for ${formatted.name}`);
      const fallbackRowId = await findExistingRowByAddress(formatted.address, tableId);
      if (fallbackRowId) {
        await axios.patch(
          `https://api.hubapi.com/cms/v3/hubdb/tables/${tableId}/rows/${fallbackRowId}/draft`,
          payload,
          { headers }
        );
        console.log(`🔁 Fallback PATCH succeeded for ${formatted.name}`);
      } else {
        console.error(`❌ Could not find row to fallback PATCH for ${formatted.name} (${tableId})`);
        console.log("📤 Debug info for this listing:");
        console.log(JSON.stringify(formatted, null, 2));
      }
    } else {
      throw postError;
    }
  }
}

(async () => {
  console.log("🔁 Fetching from AppFolio...");
  const listings = await fetchAppFolioListings();

  if (!listings.length) {
    console.warn("⚠️ No listings found to sync.");
    return;
  }

  console.log(`📦 Fetched ${listings.length} active listings`);
  console.log(`📦 Syncing ${listings.length} listings...`);

  for (const row of listings) {
    const formatted = formatListing(row);
    try {
      await upsertHubDBRow(formatted, HUBDB_TABLE_ID_INTERNAL);
    } catch (err) {
      console.error(`❌ Sync error for ${formatted.name}:`, err.message);
    }
  }
})();
