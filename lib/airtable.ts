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
const ATTIO_FIELD = "Attio"; // URL of the Attio record — the reliable match key

export const airtableConfigured = (): boolean => !!process.env.AIRTABLE_API_KEY;

export interface Submitted {
  /** Attio record ids from each submission's Attio URL (the reliable key). */
  recordIds: Set<string>;
  /** Squished company names (with and without legal suffix) — fallback only. */
  names: Set<string>;
}

const attioIdFromUrl = (u: unknown): string | undefined =>
  String(u || "").match(/\/(?:company|companies|person|people)\/([0-9a-f-]{36})/i)?.[1];

/** Drop trailing legal suffixes so "Interlock Systems Inc." == "Interlock Systems". */
export function stripLegal(name: string): string {
  return squish(
    name.replace(/[,.]?\s*\b(inc|incorporated|llc|l\.l\.c|lp|corp|corporation|co|ltd|limited)\b\.?\s*$/gi, "")
  );
}

// The submitted set changes as forms are entered; cache briefly so we stay fresh
// (a just-submitted form disappears within a minute) without hammering the API.
let cache: { at: number; value: Submitted } | null = null;
const TTL_MS = 60_000;
const emptySubmitted = (): Submitted => ({ recordIds: new Set(), names: new Set() });

/**
 * The Deal Feedback submissions from the last `days` days — primarily as Attio
 * record ids (99% of forms carry the record URL), plus company names as a
 * fallback. A Form Entry meeting is dropped when its record id (or, failing that,
 * its company name) is in here. Fails OPEN (empty) when Airtable is unreachable.
 */
export async function submittedSubmissions(days = 45): Promise<Submitted> {
  const token = process.env.AIRTABLE_API_KEY;
  if (!token) return emptySubmitted();
  if (cache && Date.now() - cache.at < TTL_MS) return cache.value;

  const value = emptySubmitted();
  const formula = `IS_AFTER(CREATED_TIME(), DATEADD(TODAY(), -${days}, 'days'))`;
  let offset: string | undefined;
  try {
    do {
      const u = new URL(`https://api.airtable.com/v0/${BASE}/${TABLE}`);
      u.searchParams.set("filterByFormula", formula);
      u.searchParams.append("fields[]", COMPANY_FIELD);
      u.searchParams.append("fields[]", ATTIO_FIELD);
      u.searchParams.set("pageSize", "100");
      if (offset) u.searchParams.set("offset", offset);
      const res = await fetch(u.toString(), {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
      });
      if (!res.ok) break;
      const j = await res.json();
      for (const r of j.records || []) {
        const id = attioIdFromUrl(r.fields?.[ATTIO_FIELD]);
        if (id) value.recordIds.add(id);
        const nm = r.fields?.[COMPANY_FIELD];
        if (nm) {
          value.names.add(squish(String(nm)));
          value.names.add(stripLegal(String(nm)));
        }
      }
      offset = j.offset;
    } while (offset);
  } catch {
    return cache?.value ?? emptySubmitted();
  }
  cache = { at: Date.now(), value };
  return value;
}

/** True if this meeting's deal already has a Deal Feedback submission. */
export function isSubmitted(sub: Submitted, recordId?: string, company?: string): boolean {
  if (recordId && sub.recordIds.has(recordId)) return true;
  if (company) {
    const s = squish(company);
    if (s && (sub.names.has(s) || sub.names.has(stripLegal(company)))) return true;
  }
  return false;
}
