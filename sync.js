const axios = require("axios");
require("dotenv").config(); // load .env variables

const APPFOLIO_CLIENT_ID = process.env.APPFOLIO_CLIENT_ID;
const APPFOLIO_CLIENT_SECRET = process.env.APPFOLIO_CLIENT_SECRET;
const HUBSPOT_API_KEY = process.env.HUBSPOT_API_KEY;
const HUBDB_TABLE_ID_INTERNAL = process.env.HUBDB_TABLE_ID; // full table (existing)
const HUBDB_TABLE_ID_PUBLIC = process.env.HUBDB_TABLE_ID_PUBLIC; // filtered table (new)

console.log("🔑 Full HUBSPOT_API_KEY:", HUBSPOT_API_KEY);
console.log("✅ APPFOLIO_CLIENT_ID:", APPFOLIO_CLIENT_ID?.slice(0, 8));

const APPFOLIO_URL = `https://${APPFOLIO_CLIENT_ID}:${APPFOLIO_CLIENT_SECRET}@coastlineequity.appfolio.com/api/v2/reports/unit_directory.json`;

function generateSlug(listing) {
  const base = listing.unit_address || listing.property_name || "untitled";
  return base
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-")
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
    const response = await axios.post(APPFOLIO_URL, {
      unit_visibility: "active",
    });
    return response.data.results || [];
  } catch (error) {
    console.error(
      "❌ AppFolio fetch error:",
      error.response?.status,
      error.response?.data || error.message
    );
    return [];
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

    if (response.data.results?.[0]) {
      console.log(
        `📋 HubDB (${tableId}) column names:`,
        Object.keys(response.data.results[0].values)
      );
    }

    const match = response.data.results.find(
      (row) => row.values && row.values.address === address
    );

    if (match) {
      console.log(`🧠 Found existing row in ${tableId} for ${address}: ID ${match.id}`);
    } else {
      console.log(`❌ No match found in ${tableId} for address: ${address}`);
    }

    return match?.id || null;
  } catch (error) {
    console.error(`❌ Error searching HubDB table (${tableId}):`, error.message);
    return null;
  }
}

async function upsertHubDBRow(listing) {
  const formatted = formatRow(listing);
  const address = formatted.address;
  const existingRowId = await findExistingRowByAddress(address);
  const payload = { values: formatted };

  try {
    const headers = {
      Authorization: `Bearer ${HUBSPOT_API_KEY}`,
      "Content-Type": "application/json",
    };

    if (existingRowId) {
      await axios.patch(
        `https://api.hubapi.com/cms/v3/hubdb/tables/${HUBDB_TABLE_ID}/rows/${existingRowId}/draft`,
        payload,
        { headers }
      );
      console.log(`🔄 Updated: ${formatted.name}`);
    } else {
      await axios.post(
        `https://api.hubapi.com/cms/v3/hubdb/tables/${HUBDB_TABLE_ID}/rows/draft`,
        payload,
        { headers }
      );
      console.log(`✅ Created: ${formatted.name}`);
    }
  } catch (error) {
    console.error(
      `❌ Sync error for ${formatted.name}:`,
      error.response?.data || error.message
    );
  }
}

async function pushLiveChanges() {
  try {
    const headers = {
      Authorization: `Bearer ${HUBSPOT_API_KEY}`,
      "Content-Type": "application/json",
    };
    await axios.post(
      `https://api.hubapi.com/cms/v3/hubdb/tables/${HUBDB_TABLE_ID}/draft/push-live`,
      {},
      { headers }
    );
    console.log("🚀 Pushed draft rows live.");
  } catch (error) {
    console.error(
      "❌ Failed to push live:",
      error.response?.data || error.message
    );
  }
}

(async function syncListings() {
  console.log("🚀 Starting sync script...");
  console.log("🔁 Fetching from AppFolio...");

  const listings = await fetchAppFolioData();
  if (!listings.length) {
    console.log("⚠️ No listings found to sync.");
    return;
  }

  console.log(`📦 Syncing ${listings.length} listings...`);

 for (const listing of listings) {
  await upsertHubDBRow(listing, HUBDB_TABLE_ID_INTERNAL); // all units

  if (listing.posted_to_internet === "Yes") {
    await upsertHubDBRow(listing, HUBDB_TABLE_ID_PUBLIC); // only public ones
  }
}

await pushLiveChanges(HUBDB_TABLE_ID_INTERNAL);
await pushLiveChanges(HUBDB_TABLE_ID_PUBLIC);

  console.log("✅ Sync complete.");
})();
