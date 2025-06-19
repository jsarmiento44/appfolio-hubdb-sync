async function fetchAppFolioData() {
  try {
    const credentials = Buffer.from(
      `${APPFOLIO_CLIENT_ID}:${APPFOLIO_CLIENT_SECRET}`
    ).toString("base64");

    const headers = {
      Authorization: `Basic ${credentials}`,
    };

    const response = await axios.get(
      "https://coastlineequity.appfolio.com/api/v2/reports/",
      { headers }
    );

    console.log("✅ Available reports:", response.data);
    return [];
  } catch (error) {
    console.error(
      "❌ AppFolio fetch error:",
      error.response?.status,
      error.response?.data || error.message
    );
    return [];
  }
}
