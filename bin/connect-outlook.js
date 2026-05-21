#!/usr/bin/env node
/*
 * One-time bootstrap: connect an Outlook / Microsoft 365 mailbox.
 *
 * Prereqs (see .env.example for the long-form walkthrough):
 *   - Azure AD app registration with delegated permissions:
 *       Mail.ReadWrite, offline_access, User.Read
 *   - "Allow public client flows" = YES on that app
 *   - OUTLOOK_CLIENT_ID env var set to the app's Application (client) ID
 *
 * Run:    OUTLOOK_CLIENT_ID=... node bin/connect-outlook.js
 *  or:    npm run connect-outlook    (after exporting OUTLOOK_CLIENT_ID)
 *
 * Output: opens a device-code flow. You sign in once at the printed URL.
 *         A refresh token is saved to .outlook-token.json (gitignored).
 */
const auth = require("../lib/graph-auth");

(async () => {
  const clientId = process.env.OUTLOOK_CLIENT_ID;
  if (!clientId) {
    console.error("ERROR: OUTLOOK_CLIENT_ID is not set.");
    console.error("See .env.example for setup steps.");
    process.exit(1);
  }

  console.log("Starting device code flow...");
  const flow = await auth.startDeviceFlow(clientId);
  console.log("");
  console.log("=".repeat(64));
  console.log(flow.message);
  console.log("=".repeat(64));
  console.log("");
  console.log("Waiting for you to complete sign-in (this will hang until you do)...");

  const tokens = await auth.pollDeviceToken(clientId, flow.device_code, flow.interval || 5);
  auth.saveTokens({
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    scope: tokens.scope,
    expires_at: Date.now() + (tokens.expires_in - 60) * 1000,
  });

  console.log("");
  console.log(`SUCCESS: tokens saved to ${auth.TOKEN_FILE}`);
  console.log("Set MONITOR_ENABLED=true and start the server to begin drafting replies.");
})().catch(err => {
  console.error("FAILED:", err.message);
  process.exit(1);
});
