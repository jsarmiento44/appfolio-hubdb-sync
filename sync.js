const axios = require("axios");
require("dotenv").config();

const APPFOLIO_CLIENT_ID = process.env.APPFOLIO_CLIENT_ID;
const APPFOLIO_CLIENT_SECRET = process.env.APPFOLIO_CLIENT_SECRET;
const HUBSPOT_API_KEY = process.env.HUBSPOT_API_KEY;
const HUBDB_TABLE_ID_INTERNAL = process.env.HUBDB_TABLE_ID;
const HUBDB_TABLE_ID_PUBLIC = process.env.HUBDB_TABLE_ID_PUBLIC;

console.log("🔑 HUBSPOT_API_KEY:", !!HUBSPOT_API_KEY);
console.log("✅ APPFOLIO_CLIENT_ID:", APPFOLIO_CLIENT_ID?.slice(0, 8));
console.log("📦 HUBDB_TABLE_ID (Internal):", HUBDB_TABLE_ID_INTERNAL);
console.log("📦 HUBDB_TABLE_ID_PUBLIC:", HUBDB_TABLE_ID_PUBLIC);

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
  return `Discover this rental in ${city || "California"} — ${description?.slice(0, 100) || ""}...`;
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
    application_fee: listing.application_fee ? parseFloat(listing.application_fee) : null,
    amenities: listing.unit_amenities || "",
    appliances: listing.unit_appliances || "",
    billed_as: listing.billed_as || "",
    meta_description: autoGenerateMeta(listing.marketing_description, listing.unit_city),
  };
}

async function fetchAppFolioData() {
  try {
    const response = await axios.get(
      "https://coastlineequity.appfolio.com/api/v2/reports/unit_directory.json",
      {
        auth: {
          username: APPFOLIO_CLIENT_ID,
          password: APPFOLIO_CLIENT_SECRET,
        },
      }
    );

    const rawListings = response.data.results || [];

    const filteredListings = rawListings.filter(
      (l) =>
        l.unit_visibility?.toLowerCase() === "active" ||
        l.visibility?.toLowerCase() === "active"
    );

    console.log(`📦 Fetched ${filteredListings.length} active listings`);
    return filteredListings;
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

async function upsertHubDBRow(listing, tableId) {
  const formatted = formatRow(listing);
  const address = formatted.address;
  const existingRowId = await findExistingRowByAddress(address, tableId);
  const payload = { values: formatted };

  const headers = {
    Authorization: `Bearer ${HUBSPOT_API_KEY}`,
    "Content-Type": "application/json",
  };

  try {
    if (existingRowId) {
      await axios.patch(
        `https://api.hubapi.com/cms/v3/hubdb/tables/${tableId}/rows/${existingRowId}/draft`,
        payload,
        { headers }
      );
      console.log(`🔄 Updated (${tableId}): ${formatted.name}`);
    } else {
      try {
        await axios.post(
          `https://api.hubapi.com/cms/v3/hubdb/tables/${tableId}/rows/draft`,
          payload,
          { headers }
        );
        console.log(`✅ Created (${tableId}): ${formatted.name}`);
      } catch (postError) {
        if (postError.response?.status === 405) {
          console.warn(`⚠️ POST failed with 405, retrying PATCH for ${formatted.name}`);
          const fallbackRowId = await findExistingRowByAddress(address, tableId);
          if (fallbackRowId) {
            await axios.patch(
              `https://api.hubapi.com/cms/v3/hubdb/tables/${tableId}/rows/${fallbackRowId}/draft`,
              payload,
              { headers }
            );
            console.log(`🔁 Fallback PATCH succeeded for ${formatted.name}`);
          } else {
            console.error(`❌ Could not find row to fallback PATCH for ${formatted.name}`);
          }
        } else {
          throw postError;
        }
      }
    }
  } catch (error) {
    console.error(`❌ Sync error for ${formatted.name} (${tableId}):`, error.response?.data || error.message);
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
  console.log("🔁 Fetching from AppFolio...");

  const listings = await fetchAppFolioData();
  if (!listings.length) {
    console.log("⚠️ No listings found to sync.");
    return;
  }

  console.log(`📦 Syncing ${listings.length} listings...`);

  for (const listing of listings) {
    await upsertHubDBRow(listing, HUBDB_TABLE_ID_INTERNAL);

    if (listing.posted_to_internet === "Yes") {
      await upsertHubDBRow(listing, HUBDB_TABLE_ID_PUBLIC);
    }
  }

  await pushLiveChanges(HUBDB_TABLE_ID_INTERNAL);
  await pushLiveChanges(HUBDB_TABLE_ID_PUBLIC);

  console.log("✅ Sync complete.");
})();
