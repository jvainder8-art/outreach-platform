const { google } = require('googleapis');
const os = require('os');
const fs = require('fs');
const path = require('path');

function resolvePath(p) {
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

function buildOAuthClient(authConfig) {
  const keysStr = process.env[authConfig.keysEnvVar]
    || fs.readFileSync(resolvePath(authConfig.keysPath), 'utf8');
  const keys = JSON.parse(keysStr);

  const credsStr = process.env[authConfig.credsEnvVar]
    || fs.readFileSync(resolvePath(authConfig.credsPath), 'utf8');
  const creds = JSON.parse(credsStr);

  const client = new google.auth.OAuth2(
    keys.installed.client_id,
    keys.installed.client_secret,
    'http://localhost:3000/callback'
  );
  client.setCredentials(creds);

  // Only persist refreshed tokens when running locally
  if (!process.env[authConfig.credsEnvVar]) {
    client.on('tokens', tokens => {
      const updated = { ...creds, ...tokens };
      fs.writeFileSync(resolvePath(authConfig.credsPath), JSON.stringify(updated, null, 2));
    });
  }

  return client;
}

async function getRows(sheetsAuth, spreadsheetId, range) {
  const auth = buildOAuthClient(sheetsAuth);
  const sheets = google.sheets({ version: 'v4', auth });
  const res = await sheets.spreadsheets.values.get({ spreadsheetId, range });
  return { rows: res.data.values || [], auth };
}

async function getStyleGuide(sheetsAuth, spreadsheetId) {
  const auth = buildOAuthClient(sheetsAuth);
  const sheets = google.sheets({ version: 'v4', auth });
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: 'Style Guide!A:B',
    });
    const rows = res.data.values || [];
    return rows.slice(1).reduce((acc, row) => {
      const field = (row[0] || '').trim();
      const value = (row[1] || '').trim();
      if (field) acc[field] = value;
      return acc;
    }, {});
  } catch {
    return {};
  }
}

async function updateRow(auth, spreadsheetId, range, values) {
  const sheets = google.sheets({ version: 'v4', auth });
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range,
    valueInputOption: 'RAW',
    requestBody: { values: [values] },
  });
}

module.exports = { getRows, updateRow, getStyleGuide };
