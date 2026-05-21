const fs = require("fs");
const path = require("path");

const TOKEN_FILE = process.env.OUTLOOK_TOKEN_FILE
  || path.join(__dirname, "..", ".outlook-token.json");

const TENANT = process.env.OUTLOOK_TENANT || "common";
const DEFAULT_SCOPES = "Mail.ReadWrite offline_access User.Read";

function loadTokens() {
  if (!fs.existsSync(TOKEN_FILE)) return null;
  try { return JSON.parse(fs.readFileSync(TOKEN_FILE, "utf8")); }
  catch { return null; }
}

function saveTokens(tokens) {
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokens, null, 2), { mode: 0o600 });
}

async function startDeviceFlow(clientId, scopes = DEFAULT_SCOPES) {
  const r = await fetch(
    `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/devicecode`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: clientId, scope: scopes }),
    }
  );
  if (!r.ok) throw new Error(`devicecode failed: ${r.status} ${await r.text()}`);
  return r.json();
}

async function pollDeviceToken(clientId, deviceCode, interval) {
  let waitSec = interval || 5;
  while (true) {
    await new Promise(res => setTimeout(res, waitSec * 1000));
    const r = await fetch(
      `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          client_id: clientId,
          device_code: deviceCode,
        }),
      }
    );
    const data = await r.json().catch(() => ({}));
    if (r.ok) return data;
    if (data.error === "authorization_pending") continue;
    if (data.error === "slow_down") { waitSec += 5; continue; }
    throw new Error(`device token failed: ${data.error_description || data.error || r.status}`);
  }
}

async function refresh(clientId) {
  const tokens = loadTokens();
  if (!tokens?.refresh_token) {
    throw new Error("No refresh token saved — run `npm run connect-outlook` first.");
  }
  const r = await fetch(
    `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: clientId,
        refresh_token: tokens.refresh_token,
        scope: tokens.scope || DEFAULT_SCOPES,
      }),
    }
  );
  if (!r.ok) throw new Error(`refresh failed: ${r.status} ${await r.text()}`);
  const data = await r.json();
  const merged = {
    ...tokens,
    access_token: data.access_token,
    refresh_token: data.refresh_token || tokens.refresh_token,
    scope: data.scope || tokens.scope,
    expires_at: Date.now() + (data.expires_in - 60) * 1000,
  };
  saveTokens(merged);
  return merged;
}

async function getAccessToken(clientId) {
  let tokens = loadTokens();
  if (tokens?.access_token && tokens.expires_at && tokens.expires_at > Date.now() + 30_000) {
    return tokens.access_token;
  }
  tokens = await refresh(clientId);
  return tokens.access_token;
}

module.exports = {
  TOKEN_FILE,
  loadTokens,
  saveTokens,
  startDeviceFlow,
  pollDeviceToken,
  refresh,
  getAccessToken,
};
