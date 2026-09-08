// One-time Google OAuth consent helper.
//
// Prereq: create an OAuth 2.0 Client (type "Web application") in Google Cloud
// Console with redirect URI  http://localhost:5555/oauth2callback  and put its
// credentials in .env.local:
//     GOOGLE_CLIENT_ID=...
//     GOOGLE_CLIENT_SECRET=...
//
// Then run:  node scripts/google-auth.mjs
// It opens a consent URL, catches the redirect, exchanges the code, and writes
// GOOGLE_REFRESH_TOKEN back into .env.local. Run once; the app uses the refresh
// token from then on. Uses only Node built-ins.

import http from "node:http";
import https from "node:https";
import { readFileSync, writeFileSync } from "node:fs";
import { URL, URLSearchParams, fileURLToPath } from "node:url";

// fileURLToPath (not .pathname) so a space in the path — "2048 Software" — isn't
// left as %20, which would break the file read.
const ENV_PATH = fileURLToPath(new URL("../.env.local", import.meta.url));
const REDIRECT = "http://localhost:5555/oauth2callback";
const SCOPE = [
  "https://www.googleapis.com/auth/calendar.readonly", // read the calendar
  "https://www.googleapis.com/auth/gmail.readonly", // read the email thread
  "https://www.googleapis.com/auth/gmail.compose", // draft + send follow-ups
  "https://www.googleapis.com/auth/drive.readonly", // read decks saved in Drive
].join(" ");

function readEnv() {
  const env = {};
  try {
    for (const line of readFileSync(ENV_PATH, "utf8").split("\n")) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m) env[m[1]] = m[2];
    }
  } catch {}
  return env;
}

function writeEnvKey(key, value) {
  let lines = [];
  try {
    lines = readFileSync(ENV_PATH, "utf8").split("\n").filter(Boolean);
  } catch {}
  lines = lines.filter((l) => !l.startsWith(key + "="));
  lines.push(`${key}=${value}`);
  writeFileSync(ENV_PATH, lines.join("\n") + "\n");
}

function postForm(host, path, form) {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams(form).toString();
    const req = https.request(
      { host, path, method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(body) } },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try { resolve(JSON.parse(data)); } catch { reject(new Error(data)); }
        });
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

const env = readEnv();
const CLIENT_ID = env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = env.GOOGLE_CLIENT_SECRET;
if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error("Missing GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET in .env.local");
  process.exit(1);
}

const authUrl =
  "https://accounts.google.com/o/oauth2/v2/auth?" +
  new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT,
    response_type: "code",
    scope: SCOPE,
    access_type: "offline",
    prompt: "consent",
  }).toString();

const server = http.createServer(async (req, res) => {
  if (!req.url.startsWith("/oauth2callback")) {
    res.writeHead(404).end();
    return;
  }
  const code = new URL(req.url, REDIRECT).searchParams.get("code");
  if (!code) {
    res.writeHead(400).end("No code");
    return;
  }
  try {
    const tok = await postForm("oauth2.googleapis.com", "/token", {
      code,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uri: REDIRECT,
      grant_type: "authorization_code",
    });
    if (!tok.refresh_token) throw new Error("No refresh_token in response: " + JSON.stringify(tok));
    writeEnvKey("GOOGLE_REFRESH_TOKEN", tok.refresh_token);
    res.writeHead(200, { "Content-Type": "text/html" }).end(
      "<h2>✅ Connected. You can close this tab and return to the terminal.</h2>"
    );
    console.log("\n✅ GOOGLE_REFRESH_TOKEN saved to .env.local. You can Ctrl-C now.");
    setTimeout(() => process.exit(0), 500);
  } catch (e) {
    res.writeHead(500).end(String(e));
    console.error(e);
  }
});

server.listen(5555, () => {
  console.log("\n1) Open this URL in your browser and approve access:\n");
  console.log(authUrl + "\n");
  console.log("Waiting for the redirect on http://localhost:5555 …");
});
