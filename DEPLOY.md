# Deploying Company Search (Render)

The app is a long-running Next.js server that persists to a local disk (`.data/`
dismiss stores + Attio links, `.cache/` day-cache) and runs multi-second Attio
scans. That means: **a container host with a persistent disk**, not a serverless
one. These steps use [Render](https://render.com); Railway/Fly.io work the same way.

## 1. Put the code on GitHub

```bash
git add -A && git commit -m "Prepare for hosting"
# create an EMPTY private repo at github.com/new (no README), then:
git remote add origin git@github.com:<you>/company-search.git
git push -u origin main
```

Secrets are safe: `.env.local`, `.data/`, and `.cache/` are gitignored.

## 2. Create the service on Render

1. Sign in to Render **with GitHub** and grant access to the repo.
2. **New → Blueprint**, pick this repo. It reads `render.yaml` and creates the
   web service + a 1 GB disk mounted at `/var/data`.
3. Render will ask for the **secret** env vars (everything marked `sync:false`).
   Paste these from your `.env.local`:
   - `ANTHROPIC_API_KEY`, `ATTIO_API_KEY`, `GRAIN_PAT`, `AIRTABLE_API_KEY`,
     `SLACK_USER_TOKEN`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`,
     `GOOGLE_REFRESH_TOKEN`
   - `APP_PASSWORD` — **you choose this**; it's the login password.
4. Click **Apply**. First deploy takes a few minutes.

Config vars (`DATA_DIR`, `CACHE_DIR`, `ENABLE_CRON=1`, `PREWARM_HOUR=7`) are already
set by the blueprint.

## 3. Use it

- Visit the Render URL → you'll get the **password screen** (from `APP_PASSWORD`).
- The **7am ET pre-warm** runs automatically (ENABLE_CRON=1), so the first open
  each morning is instant. It's DST-correct.

## Notes

- **Auth**: with `APP_PASSWORD` set, every route is gated; the pre-warm job
  authenticates itself with an internal header. Unset it (local dev) and the gate
  is disabled. To rotate the password, change the env var and redeploy — everyone
  is logged out.
- **Email safety**: `lib/gmail.ts` still has `EMAIL_TEST_MODE = true`. Keep it that
  way; nothing sends real mail. (There's no send path wired into the UI right now.)
- **Custom domain**: optional, add it under the service's Settings → Custom Domains.
- **Google refresh token**: it's long-lived; if Drive/Gmail/Calendar ever return
  auth errors, re-run `scripts/google-auth.mjs` locally and update the env var.
- **Backups**: the disk holds your dismiss stores + manual Attio links. Render
  snapshots disks; nothing else is stored there that isn't re-derivable.
