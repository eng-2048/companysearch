// Grain REST client — recordings, transcripts, and participants.
//
// The Grain MCP (semantic transcript search) needs Claude's OAuth, which a
// standalone app can't reuse, so we use Grain's REST API with a Personal Access
// Token. Matching is our own: the API's `?title=` filter is a substring search,
// so we post-filter to WHOLE-WORD title matches (keeps "Verno AI", drops the
// unrelated "Zach <> Vernon" calls) and then confirm/enrich via participants.

import { normalize, wholeWordMatch } from "./match";

const BASE = "https://api.grain.com/_/public-api";
const MAX_DETAIL_FETCHES = 10; // bound latency per search

function key(): string {
  const k = process.env.GRAIN_PAT;
  if (!k) throw new Error("GRAIN_PAT is not set (add it to .env.local)");
  return k;
}

async function api(path: string): Promise<any> {
  const res = await fetch(BASE + path, {
    headers: { Authorization: `Bearer ${key()}` },
    cache: "no-store",
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Grain ${path} -> HTTP ${res.status}: ${t.slice(0, 200)}`);
  }
  return res.json();
}

export interface GrainParticipant {
  name?: string;
  email?: string;
  external: boolean;
}

export interface GrainRecordingData {
  id: string;
  title: string;
  date?: string; // ISO
  durationMin?: number;
  summary?: string;
  summaryPoints: string[];
  url: string; // public share url
  participants: GrainParticipant[];
}

export interface GrainResolution {
  recordings: GrainRecordingData[];
  /** External (non-2048) people discovered across matched recordings. */
  externalPeople: { name: string; email?: string }[];
  emails: string[];
}

async function searchTitle(term: string): Promise<any[]> {
  const q = encodeURIComponent(term);
  const r = await api(`/recordings?title=${q}`);
  return r.recordings || [];
}

async function getDetail(id: string): Promise<any | undefined> {
  try {
    return await api(`/recordings/${id}?participants=true`);
  } catch {
    return undefined;
  }
}

/** Grain summary_points may be strings or {timestamp, text} objects — coerce to text. */
function toPointStrings(points: any): string[] {
  if (!Array.isArray(points)) return [];
  return points
    .map((p) => (typeof p === "string" ? p : p?.text || p?.summary || ""))
    .filter(Boolean);
}

function toParticipants(detail: any): GrainParticipant[] {
  const ps = detail?.participants;
  if (!Array.isArray(ps)) return [];
  return ps.map((p: any) => ({
    name: p.name || undefined,
    email: p.email || undefined,
    external: p.scope === "external",
  }));
}

/**
 * Resolve Grain content for a company/founder.
 * @param terms  candidate names to match titles against (company name, founder name…)
 */
export async function resolveGrain(terms: string[]): Promise<GrainResolution> {
  const cleanTerms = [...new Set(terms.map((t) => t.trim()).filter(Boolean))];
  if (cleanTerms.length === 0) {
    return { recordings: [], externalPeople: [], emails: [] };
  }

  // 1) Title search for each term, unioned and deduped by recording id.
  const listResults = await Promise.all(cleanTerms.map((t) => searchTitle(t)));
  const byId = new Map<string, any>();
  for (const list of listResults) {
    for (const rec of list) if (rec?.id) byId.set(rec.id, rec);
  }

  // 2) Keep only WHOLE-WORD title matches — this is what drops "Vernon" for "Verno".
  const matched = [...byId.values()].filter((rec) =>
    cleanTerms.some((t) => wholeWordMatch(rec.title || "", t))
  );

  // Most recent first; bound how many details we fetch.
  matched.sort((a, b) =>
    String(b.start_datetime || "").localeCompare(String(a.start_datetime || ""))
  );
  const toFetch = matched.slice(0, MAX_DETAIL_FETCHES);

  // 3) Fetch details (participants) in parallel.
  const details = await Promise.all(toFetch.map((rec) => getDetail(rec.id)));

  const recordings: GrainRecordingData[] = [];
  const peopleByEmail = new Map<string, { name: string; email?: string }>();
  const peopleByName = new Map<string, { name: string; email?: string }>();

  toFetch.forEach((rec, i) => {
    const detail = details[i] || rec;
    const participants = toParticipants(detail);
    recordings.push({
      id: rec.id,
      title: rec.title || "(untitled)",
      date: rec.start_datetime,
      durationMin: rec.duration_ms ? Math.round(rec.duration_ms / 60000) : undefined,
      summary:
        typeof (rec.summary || detail.summary) === "string"
          ? rec.summary || detail.summary
          : undefined,
      summaryPoints: toPointStrings(rec.summary_points || detail.summary_points),
      url: rec.public_url || rec.url || detail.public_url,
      participants,
    });

    // Collect external people — but only from small meetings, so a big pitch-day
    // recording doesn't dump dozens of unrelated founders into the result.
    const externals = participants.filter((p) => p.external);
    if (externals.length > 0 && externals.length <= 3) {
      for (const p of externals) {
        if (p.email) {
          if (!peopleByEmail.has(p.email))
            peopleByEmail.set(p.email, { name: p.name || p.email, email: p.email });
        } else if (p.name) {
          const k = normalize(p.name);
          if (k && !peopleByName.has(k)) peopleByName.set(k, { name: p.name });
        }
      }
    }
  });

  // Merge the two people maps (dedupe a name that also appeared with an email).
  const externalPeople = [...peopleByEmail.values()];
  for (const p of peopleByName.values()) {
    const already = externalPeople.some(
      (e) => normalize(e.name) === normalize(p.name)
    );
    if (!already) externalPeople.push(p);
  }

  const emails = [...peopleByEmail.keys()];

  return { recordings, externalPeople, emails };
}
