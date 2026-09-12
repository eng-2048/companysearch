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

/** The full transcript for a recording, as "Speaker: text" lines. Grain returns
 *  it inline as transcript_json when we ask for format=json (the *_txt_url is a
 *  separate signed URL that rejects our token). Bounded so it stays LLM-sized. */
export async function getTranscript(id: string): Promise<string | undefined> {
  try {
    const r = await api(`/recordings/${id}?transcript_format=json`);
    const segs = r?.transcript_json;
    if (!Array.isArray(segs) || segs.length === 0) return undefined;
    const text = segs
      .map((s: any) => `${s.speaker || "?"}: ${String(s.text || "").trim()}`)
      .filter((l: string) => l.length > 3)
      .join("\n");
    return text ? text.slice(0, 60000) : undefined; // ~15k tokens ceiling
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

/** Extra signals to match recordings the title alone can't. */
export interface GrainConfirm {
  /** External emails that confirm a recording is this company's. */
  emails?: string[];
  /** External email domains that confirm a recording (e.g. "impact-drones.com"). */
  domains?: string[];
  /** Surface-only title seeds (founder first name, email local part). Recordings
   *  found via these are kept ONLY if a participant email/domain confirms them —
   *  so a bare first name doesn't drag in unrelated calls. */
  softTerms?: string[];
}

/**
 * Resolve Grain content for a company/founder.
 * @param terms   strong title terms (company name, founder full name…) — a
 *                whole-word title match is accepted on its own.
 * @param confirm participant emails/domains + soft title seeds, so a recording
 *                whose title never names the company can still be matched by who
 *                was on the call (e.g. "Demo Day between Jasper L and Zann Ali"
 *                matched via jasper@impact-drones.com).
 */
export async function resolveGrain(
  terms: string[],
  confirm: GrainConfirm = {}
): Promise<GrainResolution> {
  const strongTerms = [...new Set(terms.map((t) => t.trim()).filter(Boolean))];
  const softTerms = [...new Set((confirm.softTerms || []).map((t) => t.trim()).filter(Boolean))].filter(
    (t) => !strongTerms.some((s) => s.toLowerCase() === t.toLowerCase())
  );
  const confirmEmails = new Set((confirm.emails || []).map((e) => e.toLowerCase()).filter(Boolean));
  const confirmDomains = new Set((confirm.domains || []).map((d) => d.toLowerCase()).filter(Boolean));
  const canConfirm = confirmEmails.size > 0 || confirmDomains.size > 0;

  if (strongTerms.length === 0 && softTerms.length === 0) {
    return { recordings: [], externalPeople: [], emails: [] };
  }

  // 1) Title search for every term (strong + soft), unioned and deduped by id.
  const listResults = await Promise.all([...strongTerms, ...softTerms].map((t) => searchTitle(t)));
  const byId = new Map<string, any>();
  for (const list of listResults) {
    for (const rec of list) if (rec?.id) byId.set(rec.id, rec);
  }

  const strongTitle = (rec: any) => strongTerms.some((t) => wholeWordMatch(rec.title || "", t));
  const participantConfirmed = (participants: GrainParticipant[]) =>
    participants.some((p) => {
      const em = (p.email || "").toLowerCase();
      if (!em) return false;
      if (confirmEmails.has(em)) return true;
      const dom = em.split("@")[1];
      return !!dom && confirmDomains.has(dom);
    });

  // 2) Without confirm signals, keep the original behaviour: only WHOLE-WORD title
  // matches (drops "Vernon" for "Verno"). With them, keep every candidate for now
  // and decide per-recording below (title match OR participant confirmation).
  const pool = canConfirm ? [...byId.values()] : [...byId.values()].filter(strongTitle);

  // Strong-title matches first, then most recent; bound how many details we fetch.
  pool.sort(
    (a, b) =>
      Number(strongTitle(b)) - Number(strongTitle(a)) ||
      String(b.start_datetime || "").localeCompare(String(a.start_datetime || ""))
  );
  const toFetch = pool.slice(0, canConfirm ? MAX_DETAIL_FETCHES + 8 : MAX_DETAIL_FETCHES);

  // 3) Fetch details (participants) in parallel.
  const details = await Promise.all(toFetch.map((rec) => getDetail(rec.id)));

  const recordings: GrainRecordingData[] = [];
  const peopleByEmail = new Map<string, { name: string; email?: string }>();
  const peopleByName = new Map<string, { name: string; email?: string }>();

  toFetch.forEach((rec, i) => {
    const detail = details[i] || rec;
    const participants = toParticipants(detail);

    // Keep on a whole-word title match, or when a participant email/domain confirms
    // it — the latter recovers calls whose title never mentions the company.
    if (!strongTitle(rec) && !participantConfirmed(participants)) return;

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
