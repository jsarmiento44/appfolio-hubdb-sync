// sync.js
const axios = require("axios");
require("dotenv").config();

// Load env vars
const APPFOLIO_CLIENT_ID = process.env.APPFOLIO_CLIENT_ID;
const APPFOLIO_CLIENT_SECRET = process.env.APPFOLIO_CLIENT_SECRET;
const APPFOLIO_DOMAIN = process.env.APPFOLIO_DOMAIN;
const HUBSPOT_API_KEY = process.env.HUBSPOT_API_KEY;
const HUBDB_TABLE_ID = process.env.HUBDB_TABLE_ID;
const HUBDB_TABLE_ID_PUBLIC = process.env.HUBDB_TABLE_ID_PUBLIC;

if (!APPFOLIO_CLIENT_ID || !APPFOLIO_CLIENT_SECRET || !APPFOLIO_DOMAIN || !HUBSPOT_API_KEY || !HUBDB_TABLE_ID || !HUBDB_TABLE_ID_PUBLIC) {
  console.error("\u274C Missing required environment variables.");
  process.exit(1);
}

console.log("\uD83D\uDD11 HUBSPOT_API_KEY:", !!HUBSPOT_API_KEY);
console.log("\u2705 APPFOLIO_CLIENT_ID:", APPFOLIO_CLIENT_ID?.slice(0, 8));
console.log("\uD83D\uDCE6 HUBDB_TABLE_ID (Internal):", HUBDB_TABLE_ID);
console.log("\uD83D\uDCE6 HUBDB_TABLE_ID_PUBLIC:", HUBDB_TABLE_ID_PUBLIC);

const APPFOLIO_URL = `https://${APPFOLIO_DOMAIN}.appfolio.com/api/v2/reports/unit_directory.json`;

function generateSlug(listing) {
  const base = listing.unit_address || listing.property_name || "untitled";
  return base
    .toLowerCase()
    .replace(/[^
