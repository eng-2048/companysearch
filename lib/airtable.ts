// Airtable read client — used ONLY to detect which recent meetings already have a
// Deal Feedback form submitted, so Form Entry can drop them (it becomes a running
// to-do list of forms still to submit). Read-only; never writes to Airtable.
//
// Needs a Personal Access Token in AIRTABLE_API_KEY with data.records:read on the
// Deal Feedback base. Absent → this no-ops (nothing is auto-removed).

import { squish } from "./match";

const BASE = "appV89PYGo3zN47f9"; // Deal Feedback base
const TABLE = "tblfIpeFbZmHECtg3"; // "Deal Feedback" (submissions)
const COMPANY_FIELD = "Company Name";

export const airtableConfigured = (): boolean => !!process.env.AIRTABLE_API_KEY;

// The submitted set changes as forms are entered; cache briefly so we stay fresh
// (a just-submitted form disappears within a minute) without hammering the API.
let cache: { at: number; set: Set<string> } | null = null;
const TTL_MS = 60_000;

/**
 * Squished company names that already have a Deal Feedback submission in the last
 * `days` days. Matching Form Entry rows are dropped from the list. Returns an empty
 * set when no token is configured or on any error (fail open — never hide a
 * meeting because Airtable was unreachable).
 */
export async function submittedCompanyKeys(days = 45): Promise<Set<string>> {
  const token = process.env.AIRTABLE_API_KEY;
  if (!token) return new Set();
  if (cache && Date.now() - cache.at < TTL_MS) return cache.set;

  const out = new Set<string>();
  const formula = `IS_AFTER(CREATED_TIME(), DATEADD(TODAY(), -${days}, 'days'))`;
  let offset: string | undefined;
  try {
    do {
      const u = new URL(`https://api.airtable.com/v0/${BASE}/${TABLE}`);
      u.searchParams.set("filterByFormula", formula);
      u.searchParams.append("fields[]", COMPANY_FIELD);
      u.searchParams.set("pageSize", "100");
      if (offset) u.searchParams.set("offset", offset);
      const res = await fetch(u.toString(), {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
      });
      if (!res.ok) break;
      const j = await res.json();
      for (const r of j.records || []) {
        const nm = r.fields?.[COMPANY_FIELD];
        if (nm) out.add(squish(String(nm)));
      }
      offset = j.offset;
    } while (offset);
  } catch {
    return cache?.set ?? new Set();
  }
  cache = { at: Date.now(), set: out };
  return out;
}
