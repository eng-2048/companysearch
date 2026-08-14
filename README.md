# Company Search

Type a company or founder → get everything 2048 Ventures already knows, gathered
from Attio, Google Calendar, Grain, and email into one **Context Bundle**.

This is the software version of the `company-search` skill. It is a
context-*gathering* tool only — it collects and structures, it does not analyze,
score, or recommend.

## Stack

- **Next.js 14** (App Router, TypeScript) — deployable to Vercel
- Streaming NDJSON API so progress shows live while the gather runs
- The Context Bundle schema lives in [`lib/types.ts`](lib/types.ts)

## Run locally

```bash
npm install
npm run dev
```

Then open http://localhost:3000.

## Roadmap

- **Phase 0 — UI shell (done).** Search box + result card (summary + links,
  expandable to the full bundle), streaming progress, on mock data.
- **Phase 1 — Live brain.** `app/api/search/route.ts` swaps the mock for a
  Claude Agent SDK run that loads the `company-search` SKILL.md as its system
  prompt and reaches **Attio** and **Grain** over MCP. Output forced to the
  Context Bundle JSON schema.
- **Phase 2 — Google Calendar** via Google OAuth (the one net-new credential),
  completing the timeline spine.
- **Phase 3 — Team-ready.** Auth, a persistent backend for the multi-round-trip
  gather, secrets management, production deploy.

## Project layout

```
app/
  page.tsx              search box + streaming client
  layout.tsx            root layout
  globals.css           theme
  api/search/route.ts   streaming endpoint (mock now → Agent SDK in Phase 1)
components/
  ResultCard.tsx        summary+links card, expandable full bundle
lib/
  types.ts              Context Bundle schema (source of truth)
  mockData.ts           sample bundle for Phase 0
```
