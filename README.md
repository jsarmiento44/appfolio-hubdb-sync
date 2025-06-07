# AppFolio to HubDB Sync

This Node.js script syncs rental listings from AppFolio's Reports API into a HubSpot HubDB table.

## Features

- Pulls `unit_directory.json` from AppFolio API
- Formats listing data for HubDB
- Automatically upserts rows based on address
- Auto-generates meta descriptions
- Secure `.env` configuration

## Environment Variables

Create a `.env` file in the project root with the following contents:

```env
APPFOLIO_CLIENT_ID=your_client_id  
APPFOLIO_CLIENT_SECRET=your_client_secret  
HUBSPOT_API_KEY=your_private_app_token  
HUBDB_TABLE_ID=your_table_id  

Usage
Install dependencies:
npm install
Run the script locally:
node sync.js
(Optional) Set up a GitHub Action to run the script on a schedule for automated syncing.

Notes
.env and node_modules/ are excluded from Git using .gitignore.
Make sure your HubDB table in HubSpot has matching column names with what the script expects (e.g., zip, address, city, rent, etc.).
You must use a private app token with hubdb scope enabled.
