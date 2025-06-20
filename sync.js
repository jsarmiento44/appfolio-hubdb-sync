// ✅ COMPATIBLE SYNC SCRIPT WITHOUT OPTIONAL CHAINING

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
console.log("✅ APPFOLIO_CLIENT_ID:", (APPFOLIO_CLIENT_ID || "").slice(0, 8));
console.log("🏠 HUBDB_TABLE_ID (Internal):", HUBDB_TABLE_ID);
console.log("🌐 HUBDB_TABLE_ID_PUBLIC:", HUBDB_TABLE_ID_PUBLIC);

const APPFOLIO_URL = "https://" + APPFOLIO_DOMAIN + ".appfolio.com/api/v2/reports/unit_directory.json";

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
  return "Discover this rental in " + (city || "California") + " — " +
    ((description || "").slice(0, 100)) + "...";
}

function isInternetPosted(listing) {
  const p = listing.posted_to_internet;
  return (typeof p === "string" && p.toLowerCase() === "yes") || p === true;
}

function formatRow(listing, includeInternetFlag) {
  const row = {
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
    application_fee: listing.application_fee ? parseFloat(listing.application_fee) : null,
    amenities: listing.unit_amenities || "",
    appliances: listing.unit_appliances || "",
    utilities: listing.unit_utilities || "",
    billed_as: listing.billed_as || "",
    meta_description: autoGenerateMeta(listing.marketing_description, listing.unit_city),
  };

  if (includeInternetFlag) {
    row.posted_to_internet = isInternetPosted(listing) ? "yes" : "no";
  }

  return row;
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

    const rawListings = response.data && response.data.results ? response.data.results : [];

    const activeListings = rawListings.filter(function (l) {
      return (l.unit_visibility && l.unit_visibility.toLowerCase() === "active") ||
        (l.visibility && l.visibility.toLowerCase() === "active");
    });

    const internetListings = activeListings.filter(isInternetPosted);

    console.log("🧪 Sample fields:", rawListings[0] ? Object.keys(rawListings[0]) : []);
    console.log("📦 Active listings:", activeListings.length);
    console.log("📤 Internet-posted listings:", internetListings.length);

    return { activeListings: activeListings, internetListings: internetListings };
  } catch (error) {
    console.error("❌ AppFolio fetch error:", error.response ? error.response.status : "unknown", error.response ? error.response.data : error.message);
    return { activeListings: [], internetListings: [] };
  }
}

const failedListings = [];

async function findExistingRowByAddress(address, tableId) {
  try {
    const res = await axios.get(
      "https://api.hubapi.com/cms/v3/hubdb/tables/" + tableId + "/rows",
      {
        headers: {
          Authorization: "Bearer " + HUBSPOT_API_KEY,
          "Content-Type": "application/json",
        },
      }
    );

    const normalized = address ? address.trim().toLowerCase() : "";
    const result = res.data && res.data.results ? res.data.results : [];

    for (var i = 0; i < result.length; i++) {
      var row = result[i];
      var rowAddress = row.values && row.values.address ? row.values.address.trim().toLowerCase() : "";
      if (rowAddress === normalized) return row.id;
    }
    return null;
  } catch (err) {
    return null;
  }
}

async function upsertHubDBRow(listing, tableId) {
  const isPublicTable = tableId === HUBDB_TABLE_ID_PUBLIC;
  const formatted = formatRow(listing, !isPublicTable); // 👈 Add 'posted_to_internet' only for internal table

  if (!formatted.title || formatted.rent === 0) {
    console.warn("⚠️ Skipping: Missing title or rent = 0 – " + formatted.name);
    return;
  }

  const label = isPublicTable ? "🌐 PUBLIC" : "🏠 INTERNAL";

  const headers = {
    Authorization: "Bearer " + HUBSPOT_API_KEY,
    "Content-Type": "application/json",
  };

  const rowUrl = "https://api.hubapi.com/cms/v3/hubdb/tables/" + tableId + "/rows";
  const existingId = await findExistingRowByAddress(formatted.address, tableId);
  let payload = { values: formatted };

if (existingId) {
  try {
    const existingRowRes = await axios.get(`${rowUrl}/${existingId}`, { headers });
    const existingValues = existingRowRes.data && existingRowRes.data.values ? existingRowRes.data.values : {};

    for (let i = 1; i <= 7; i++) {
      const key = `photo_${i}`;
      if (existingValues[key]) {
        payload.values[key] = existingValues[key]; // Preserve existing image
      } else {
        delete payload.values[key]; // Avoid overwriting with null
      }
    }
  } catch (err) {
    console.warn("⚠️ Couldn't retrieve existing photos for row preservation:", formatted.name);
  }
}

  try {
    if (existingId) {
      try {
        await axios.put(rowUrl + "/" + existingId + "/draft", {}, { headers: headers });
        await axios.patch(rowUrl + "/" + existingId + "/draft", payload, { headers: headers });
        console.log("🔄 Updated (" + label + "): " + formatted.name);
      } catch (err) {
        var status = err.response ? err.response.status : null;
        if (status === 400 || status === 405) {
          console.warn("♻️ Recreating due to error " + status + " (" + label + "): " + formatted.name);
          await axios.delete(rowUrl + "/" + existingId, { headers: headers });

          if (isPublicTable) {
            await axios.post(rowUrl, payload, { headers: headers });
            console.log("✅ Recreated LIVE (" + label + "): " + formatted.name);
          } else {
            await axios.post(rowUrl + "/draft", payload, { headers: headers });
            console.log("✅ Recreated DRAFT (" + label + "): " + formatted.name);
          }
        } else {
          failedListings.push(formatted.name);
          console.error("❌ Failed to update (" + label + "): " + formatted.name);
          console.error(err.response ? err.response.data : err.message);
        }
      }
    } else {
      await axios.post(rowUrl + "/draft", payload, { headers: headers });
      console.log("✅ Created (" + label + "): " + formatted.name);
    }
  } catch (err) {
    failedListings.push(formatted.name);
    console.error("❌ Final error syncing (" + label + "): " + formatted.name);
    console.error("🔍 Error Message:", err.response ? err.response.data : err.message);
    console.log("📄 Payload Attempted:", JSON.stringify(payload, null, 2));
    console.log("📍 Table ID:", tableId);
    console.log("📬 Endpoint:", existingId ? rowUrl + "/" + existingId + "/draft" : rowUrl + "/draft");
  }
}

async function pushLiveChanges(tableId) {
  try {
    await axios.post(
      "https://api.hubapi.com/cms/v3/hubdb/tables/" + tableId + "/draft/push-live",
      {},
      {
        headers: {
          Authorization: "Bearer " + HUBSPOT_API_KEY,
          "Content-Type": "application/json",
        },
      }
    );
    console.log("🚀 Pushed draft rows live for table " + tableId);
  } catch (error) {
    console.error("❌ Push live failed (" + tableId + "):", error.response ? error.response.data : error.message);
  }
}

(async function syncListings() {
  console.log("🚀 Starting sync...");
  const data = await fetchAppFolioData();
  const activeListings = data.activeListings || [];
  const internetListings = data.internetListings || [];

  if (!activeListings.length) {
    console.log("⚠️ No active listings found.");
    return;
  }

  console.log("🛠 Syncing INTERNAL listings to table: " + HUBDB_TABLE_ID);
  for (var i = 0; i < activeListings.length; i++) {
    await upsertHubDBRow(activeListings[i], HUBDB_TABLE_ID);
  }

  console.log("🌐 Syncing PUBLIC listings to table: " + HUBDB_TABLE_ID_PUBLIC);
  for (var j = 0; j < internetListings.length; j++) {
    console.log("🧾 Checking listing:", {
      title: internetListings[j].marketing_title,
      rent: internetListings[j].advertised_rent,
      address: internetListings[j].unit_address,
    });
    await upsertHubDBRow(internetListings[j], HUBDB_TABLE_ID_PUBLIC);
  }

  await pushLiveChanges(HUBDB_TABLE_ID);
  await pushLiveChanges(HUBDB_TABLE_ID_PUBLIC);

  console.log("✅ Sync complete.");
  if (failedListings.length) {
    console.warn("❌ Listings that failed after all retries:");
    for (var k = 0; k < failedListings.length; k++) {
      console.warn(" -", failedListings[k]);
    }
  }
})();
