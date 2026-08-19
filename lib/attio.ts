// Attio REST client — the retrieval layer for the company-search app.
// Implements Step 1 of the skill (resolve the entity) directly against the API:
// search companies AND people by name, union candidate company records, collect
// every email, and find the deal_flow entry by walking each candidate record's
// list entries. Read-only.

import { squish, wholeWordMatch } from "./match";

const BASE = "https://api.attio.com/v2";

const COMPANIES_OBJECT = "5d5f1d54-8b3d-4b70-9419-bed8c153dff6";
const PEOPLE_OBJECT = "399c6054-a063-4fe3-bb75-ac9b18bc0354";
const DEAL_FLOW_SLUG = "deal_flow";

function key(): string {
  const k = process.env.ATTIO_API_KEY;
  if (!k) throw new Error("ATTIO_API_KEY is not set (add it to .env.local)");
  return k;
}

async function api(path: string, body?: unknown, method?: string): Promise<any> {
  const res = await fetch(BASE + path, {
    method: method || (body === undefined ? "GET" : "POST"),
    headers: {
      Authorization: `Bearer ${key()}`,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    // Attio is external; never cache CRM reads.
    cache: "no-store",
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Attio ${path} -> HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  return res.json();
}

const DEAL_FLOW_STATUS_ATTR = "9eb938eb-af9f-4f5e-8a26-ba2616b42a60";

/** The deal_flow pipeline status options (ordered, active), as titles. */
export async function listStatuses(): Promise<string[]> {
  try {
    const r = await api(`/lists/${DEAL_FLOW_SLUG}/attributes/${DEAL_FLOW_STATUS_ATTR}/statuses`);
    return (r.data || []).filter((s: any) => !s.is_archived).map((s: any) => s.title);
  } catch {
    return [];
  }
}

/** Write a new pipeline status onto a deal_flow list entry. */
export async function updateStatus(entryId: string, status: string): Promise<void> {
  await api(
    `/lists/${DEAL_FLOW_SLUG}/entries/${entryId}`,
    { data: { entry_values: { status } } },
    "PATCH"
  );
}

// ---------- value extractors (Attio wraps every value in a versioned array) ----------

const first = (v: any): any => (Array.isArray(v) && v.length ? v[0] : undefined);
const textVal = (v: any): string | undefined => first(v)?.value || undefined;
const selectVal = (v: any): string | undefined => first(v)?.option?.title || undefined;
const statusVal = (v: any): string | undefined => first(v)?.status?.title || undefined;
const dateVal = (v: any): string | undefined => first(v)?.value || undefined;

function currencyVal(v: any): string | undefined {
  const it = first(v);
  if (!it) return undefined;
  const amount = it.currency_value ?? it.value;
  if (amount == null) return undefined;
  const code = it.currency_code || "USD";
  const n = Number(amount);
  if (Number.isNaN(n)) return String(amount);
  return `${code === "USD" ? "$" : code + " "}${n.toLocaleString()}`;
}

function recordName(rec: any): string | undefined {
  const nameVal = rec?.values?.name;
  const it = first(nameVal);
  return it?.full_name || it?.value || undefined;
}

function recordDomains(rec: any): string[] {
  const d = rec?.values?.domains;
  if (!Array.isArray(d)) return [];
  return d
    .map((x: any) => x.domain || x.value)
    .filter(Boolean)
    // ignore Attio's generated dummy domains for stealth records
    .filter((dom: string) => !/^dummy-rec/i.test(dom));
}

function recordEmails(rec: any): string[] {
  const e = rec?.values?.email_addresses;
  if (!Array.isArray(e)) return [];
  return e.map((x: any) => x.email_address || x.original_email_address).filter(Boolean);
}

function recordId(rec: any): string {
  return rec?.id?.record_id;
}

function lastInteractionAt(rec: any): string | undefined {
  const li = first(rec?.values?.last_interaction) || first(rec?.values?.last_email_interaction);
  return li?.interacted_at || undefined;
}

/** Attio mirrors the connected Google calendar as aggregate interaction timestamps. */
function calInteractionAt(rec: any, field: string): string | undefined {
  return first(rec?.values?.[field])?.interacted_at || undefined;
}

// ---------- API primitives ----------

async function nameFilter(
  object: string,
  op: "$contains" | "$starts_with",
  term: string,
  limit = 25
): Promise<any[]> {
  const r = await api(`/objects/${object}/records/query`, {
    filter: { name: { [op]: term } },
    limit,
  });
  return r.data || [];
}

/**
 * Spacing/punctuation variants of a query so at least one is a literal substring
 * of the stored name. Attio's `$contains` is byte-literal: "pin24" is NOT a
 * substring of "Pin 24", nor "pin 24" of "Pin24". Splitting at letter/digit
 * boundaries and collapsing spaces covers both directions.
 */
function nameVariants(term: string): string[] {
  const t = term.trim();
  const lower = t.toLowerCase();
  const set = new Set<string>([t]);
  set.add(lower.replace(/([a-z])([0-9])/gi, "$1 $2").replace(/([0-9])([a-z])/gi, "$1 $2")); // deglue: pin24 -> pin 24
  set.add(lower.replace(/\s+/g, "")); // collapse: pin 24 -> pin24
  return [...set].map((s) => s.trim()).filter(Boolean);
}

/**
 * Space- and punctuation-tolerant name search (companies or people). Fires the
 * spacing variants as `$contains`; then, only when nothing squish-matches the
 * query, recovers glued names ("ekholabs" -> "Ekho Labs", "opxexchange" ->
 * "OPX Exchange") via anchored `$starts_with` on decreasing prefixes of the
 * glued term. The recovery filter is strict (stored name squished must equal or
 * contain the typed term) so a short prefix can't drag in unrelated records.
 * Measured on 60 real names this cuts glued-name misses ~85%+ with no false hits.
 */
async function searchByName(object: string, term: string, limit = 25): Promise<any[]> {
  const byId = new Map<string, any>();
  const add = (recs: any[]) => {
    for (const c of recs) {
      const id = recordId(c);
      if (id && !byId.has(id)) byId.set(id, c);
    }
  };

  const variants = nameVariants(term);
  const batches = await Promise.all(
    variants.map((q) => nameFilter(object, "$contains", q, limit).catch(() => []))
  );
  batches.forEach(add);

  const tsq = squish(term);
  const satisfied = [...byId.values()].some((c) => {
    const n = squish(recordName(c) || "");
    return n && (n === tsq || n.includes(tsq) || tsq.includes(n));
  });

  if (!satisfied && tsq.length >= 4) {
    const glued = term.toLowerCase().replace(/\s+/g, "");
    // Longest prefix first (most precise); floor at 3 to catch acronym first
    // words ("OPX Exchange", "MRI Software"). Recovery runs only on a real miss.
    const lens = [
      ...new Set([Math.min(glued.length, 10), 8, 6, 5, 4, 3].filter((l) => l >= 3 && l <= glued.length)),
    ].sort((a, b) => b - a);
    for (const len of lens) {
      const pref = glued.slice(0, len);
      let hits: any[] = [];
      try {
        hits = await nameFilter(object, "$starts_with", pref, 50);
      } catch {
        hits = [];
      }
      const good = hits.filter((c) => {
        const n = squish(recordName(c) || "");
        return n === tsq || n.includes(tsq);
      });
      if (good.length) {
        add(good);
        if (good.some((c) => squish(recordName(c) || "") === tsq)) break;
      }
    }
  }

  return [...byId.values()];
}

async function getRecord(object: string, id: string): Promise<any | undefined> {
  try {
    const r = await api(`/objects/${object}/records/${id}`);
    return r.data;
  } catch {
    return undefined;
  }
}

/** All list entries a given record belongs to (across lists). */
async function recordEntries(object: string, id: string): Promise<any[]> {
  try {
    const r = await api(`/objects/${object}/records/${id}/entries`);
    return r.data || [];
  } catch {
    return [];
  }
}

async function getDealFlowEntry(entryId: string): Promise<any | undefined> {
  try {
    const r = await api(`/lists/${DEAL_FLOW_SLUG}/entries/${entryId}`);
    return r.data;
  } catch {
    return undefined;
  }
}

async function getNotes(object: string, recordId: string): Promise<any[]> {
  try {
    const r = await api(
      `/notes?parent_object=${object}&parent_record_id=${recordId}&limit=25`
    );
    return r.data || [];
  } catch {
    return [];
  }
}

// ---------- normalized result ----------

export interface DealFlow {
  status?: string;
  introDByType?: string;
  introDById?: { object: string; recordId: string };
  introDByName?: string;
  introDByEmail?: string;
  introDByIsPerson?: boolean;
  verticals?: string;
  location?: string;
  dateFounded?: string;
  ceoLinkedin?: string;
  ctoLinkedin?: string;
  dealFolder?: string;
  deckUrl?: string;
  videoLink?: string;
  firstMeetingRecording?: string;
  nextSteps?: string;
  reasonForPass?: string;
  capitalRaised?: string;
  capitalRaising?: string;
  sourcedBy?: string;
  followUpDate?: string;
  dealTags?: string;
  companyDomain?: string;
  school?: string;
}

export interface ResolvedPerson {
  name: string;
  recordId: string;
  emails: string[];
  linkedin?: string;
  jobTitle?: string;
}

export interface AttioNote {
  title: string;
  date?: string;
  extract: string;
  noteId?: string;
  parentObject?: string; // "companies" | "people"
  parentRecordId?: string;
}

export interface AttioResolution {
  found: boolean;
  featuredCompany?: {
    name: string;
    recordId: string;
    domain?: string;
    description?: string;
    location?: string;
    founded?: string;
    fundingRaised?: string;
    isStealth: boolean;
    webUrl?: string;
  };
  /** The founder's display name (from a person record, or the stealth company name). */
  founderName?: string;
  /** The deal_flow list entry id — needed to write the pipeline status back. */
  dealFlowEntryId?: string;
  allCompanyRecordIds: string[];
  people: ResolvedPerson[];
  emails: string[];
  dealFlow?: DealFlow;
  notes: AttioNote[];
  lastInteractionAt?: string;
  /** From Attio's calendar mirror — a real upcoming meeting date (prep signal). */
  nextMeetingAt?: string;
  lastMeetingAt?: string;
  candidatesConsidered: number;
}

const isStealthName = (name: string): boolean => /\bstealth\b/i.test(name);
const looksLikePersonName = (name: string): boolean => {
  const base = name.replace(/\(.*?\)/g, "").trim();
  const words = base.split(/\s+/);
  return words.length >= 2 && words.length <= 4 && /^[A-Z]/.test(base);
};

function cleanTerm(query: string): string {
  // strip "(Stealth)" and similar parentheticals for the name search
  return query.replace(/\(.*?\)/g, "").trim();
}

function noteBodyExtract(n: any): string {
  const content =
    n.content_plaintext || n.content?.plaintext || n.content_markdown || n.content || "";
  const s = String(content).replace(/\s+/g, " ").trim();
  return s.length > 400 ? s.slice(0, 400) + "…" : s;
}


const normName = (s: string): string =>
  s.toLowerCase().replace(/\(.*?\)/g, "").replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();

const titleCase = (s: string): string =>
  s.replace(/\b[a-z]/g, (m) => m.toUpperCase());

/** "rooshil@autonomyhealth.io" -> "Rooshil"; "john.smith@x.com" -> "John Smith". */
function nameFromEmail(email?: string): string | undefined {
  if (!email) return undefined;
  const local = email.split("@")[0];
  const parts = local
    .split(/[._-]+/)
    .filter((p) => p && !/^\d+$/.test(p) && p.length > 1);
  if (parts.length === 0) return undefined;
  return titleCase(parts.join(" "));
}

/** Extract the /in/<slug> handle from a LinkedIn URL. */
function linkedinSlug(url?: string): string | undefined {
  if (!url) return undefined;
  const m = url.match(/\/in\/([^/?#]+)/i);
  return m ? m[1].toLowerCase() : undefined;
}

/** "natalie-curnes-92844597" -> "Natalie Curnes"; "rooshilshah" -> undefined (no split). */
function nameFromSlug(slug?: string): string | undefined {
  if (!slug) return undefined;
  const parts = slug
    .split(/[-.]+/)
    .filter((p) => p && !/\d/.test(p) && p.length > 1);
  if (parts.length < 2) return undefined; // single concatenated token can't be split safely
  return titleCase(parts.join(" "));
}

/** Does this person plausibly own this LinkedIn slug (by email local part or name)? */
function personMatchesSlug(
  emails: string[],
  name: string | undefined,
  slug: string
): boolean {
  const s = slug.replace(/[^a-z0-9]/g, "");
  for (const e of emails) {
    const local = e.split("@")[0].replace(/[^a-z0-9]/gi, "").toLowerCase();
    if (local.length >= 3 && s.includes(local)) return true;
  }
  if (name) {
    const tokens = normName(name).split(" ").filter((t) => t.length >= 3);
    if (tokens.length && tokens.every((t) => s.includes(t))) return true;
  }
  return false;
}

/**
 * Step 1 of the skill, as deterministic API calls.
 *
 * Resolution is anchored to a COMPANY, never to a name-substring match. Searching
 * Attio by the raw query term also returns coincidental hits (searching "verno"
 * matches people named "Vernon" and the company "Governors Island"), so people
 * are only ever attached to the resolved company via a real link — a team edge,
 * a person->company link, or, for a founder-name query, a full-name match.
 */
export async function resolveEntity(
  query: string,
  opts: { emailHints?: string[]; recordId?: string } = {}
): Promise<AttioResolution> {
  const term = cleanTerm(query) || query.trim();
  const queryIsPerson = looksLikePersonName(query);
  const qn = normName(term);
  const qsq = squish(term);

  // Attendee/founder emails are the most reliable key (a meeting title is often a
  // joke or a person's name; the email domain is the company). Include the query
  // itself if it's an email.
  const emailHints = [
    ...(opts.emailHints || []),
    ...(query.includes("@") ? [query.trim()] : []),
  ].map((e) => e.toLowerCase());

  // Fire company + people searches together.
  const [companyHits, peopleHits] = await Promise.all([
    searchByName(COMPANIES_OBJECT, term),
    searchByName(PEOPLE_OBJECT, term),
  ]);

  // People are only "plausibly the founder" when the query itself is a person
  // name AND the record's full name actually contains it — this is what keeps
  // "verno" from matching "Vernon Gair".
  const plausiblePeople = queryIsPerson
    ? peopleHits.filter((p) => {
        const raw = recordName(p) || "";
        return normName(raw).includes(qn) || (qsq.length >= 4 && squish(raw).includes(qsq));
      })
    : [];

  // Candidate companies: name-matched companies + companies linked from the
  // plausible founder-people (NOT from every coincidental people hit).
  const companyById = new Map<string, any>();
  for (const c of companyHits) companyById.set(recordId(c), c);
  const linkedIds = new Set<string>();
  for (const p of plausiblePeople) {
    const cid = first(p.values?.company)?.target_record_id;
    if (cid) linkedIds.add(cid);
  }
  const missingLinked = [...linkedIds].filter((id) => !companyById.has(id));
  const linkedFetched = await Promise.all(
    missingLinked.map((id) => getRecord(COMPANIES_OBJECT, id))
  );
  for (const c of linkedFetched) if (c) companyById.set(recordId(c), c);

  // Email/domain resolution — the reliable key. Match each hint's domain to a
  // company's domains, and the email to a person record (→ their company).
  const emailMatchedIds = new Set<string>();
  const GENERIC_DOMAINS = new Set([
    "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "yahoo.com",
    "icloud.com", "me.com", "proton.me", "protonmail.com", "aol.com",
  ]);
  for (const email of [...new Set(emailHints)]) {
    const dom = email.split("@")[1]?.toLowerCase();
    if (!dom || GENERIC_DOMAINS.has(dom) || /\.(edu|ac\.[a-z]{2})$/.test(dom)) continue;
    try {
      const cr = await api(`/objects/${COMPANIES_OBJECT}/records/query`, {
        filter: { domains: { $contains: dom } },
        limit: 3,
      });
      for (const c of cr.data || []) {
        companyById.set(recordId(c), c);
        emailMatchedIds.add(recordId(c));
      }
    } catch {
      /* ignore */
    }
    try {
      const pr = await api(`/objects/${PEOPLE_OBJECT}/records/query`, {
        filter: { email_addresses: { $contains: email } },
        limit: 3,
      });
      for (const p of pr.data || []) {
        const cid = first(p.values?.company)?.target_record_id;
        if (!cid) continue;
        if (!companyById.has(cid)) {
          const rec = await getRecord(COMPANIES_OBJECT, cid);
          if (rec) companyById.set(cid, rec);
        }
        if (companyById.has(cid)) emailMatchedIds.add(cid);
      }
    } catch {
      /* ignore */
    }
  }

  // Fallback for stealth deals with no person record and a company name that
  // isn't the founder's (e.g. "Immortal Security" for Aurnov Chattopadhyay): the
  // only Attio link to the founder is the deal_flow CEO/CTO LinkedIn slug
  // ("…/in/aurnovcy"). Match the founder-name query against those slugs, and
  // accept only an UNAMBIGUOUS single hit (avoids common-first-name collisions).
  let matchedViaLinkedin = false;
  if (companyById.size === 0 && queryIsPerson) {
    const nameTokens = qn.split(" ").filter((t) => t.length >= 3);
    const firstTok = nameTokens[0];
    const lastTok = nameTokens[nameTokens.length - 1];
    // Gather candidate deal_flow parents whose CEO/CTO LinkedIn contains any
    // long name token (last names like "chattopadhyay" also match relatives'
    // records, so this is only a candidate set — we disambiguate next).
    const parents = new Set<string>();
    for (const tok of nameTokens.filter((t) => t.length >= 5)) {
      for (const field of ["ceo_linkedin", "cto_linkedin"]) {
        try {
          const r = await api(`/lists/${DEAL_FLOW_SLUG}/entries/query`, {
            filter: { [field]: { $contains: tok } },
            limit: 5,
          });
          for (const e of r.data || []) if (e.parent_record_id) parents.add(e.parent_record_id);
        } catch {
          /* field not filterable — ignore */
        }
      }
    }
    // Score each candidate by how well its LinkedIn slug matches the full name —
    // the first name is the specific identifier ("aurnovcy" vs "…chattopadhyay").
    const scored: { rec: any; score: number }[] = [];
    for (const pid of parents) {
      const entries = await recordEntries(COMPANIES_OBJECT, pid);
      const de = entries.find((e) => e.list_api_slug === DEAL_FLOW_SLUG);
      if (!de) continue;
      const entry = await getDealFlowEntry(de.entry_id);
      const ev = entry?.entry_values || {};
      const slugText = [textVal(ev.ceo_linkedin), textVal(ev.cto_linkedin)]
        .map((u) => linkedinSlug(u) || "")
        .join(" ")
        .replace(/[^a-z0-9]/g, "");
      let score = 0;
      if (firstTok && slugText.includes(firstTok)) score += 2;
      if (lastTok && lastTok !== firstTok && slugText.includes(lastTok)) score += 1;
      const rec = await getRecord(COMPANIES_OBJECT, pid);
      if (rec) scored.push({ rec, score });
    }
    scored.sort((a, b) => b.score - a.score);
    // Accept either a confident first-name match that clearly wins, or a single
    // unambiguous match on a distinctive token (e.g. "ravenna" -> "/in/jravenna",
    // where the slug drops the first name).
    const confidentWinner =
      scored[0]?.score >= 2 && (scored.length === 1 || scored[0].score > scored[1].score);
    const soleMatch = scored.length === 1 && scored[0].score >= 1;
    if (confidentWinner || soleMatch) {
      companyById.set(recordId(scored[0].rec), scored[0].rec);
      matchedViaLinkedin = true;
    }
  }

  // Caller picked a specific company (disambiguation) — resolve to exactly that
  // record so everything downstream (deal_flow, people, notes) is scoped to it.
  if (opts.recordId) {
    const rec = companyById.get(opts.recordId) || (await getRecord(COMPANIES_OBJECT, opts.recordId));
    companyById.clear();
    if (rec) companyById.set(opts.recordId, rec);
  }

  const candidateCompanies = [...companyById.values()];

  if (candidateCompanies.length === 0) {
    return {
      found: false,
      allCompanyRecordIds: [],
      people: [],
      emails: [],
      notes: [],
      candidatesConsidered: 0,
    };
  }

  // How well a company's name matches the query — used to pick the right record
  // when several match (e.g. the real "Verno" over "Governors Island"). Compare
  // both word-normalized and squished (space/punct-insensitive) so "pin24"
  // scores an exact hit on a record stored as "Pin 24".
  const nameScore = (c: any): number => {
    const raw = recordName(c) || "";
    const n = normName(raw);
    const nsq = squish(raw);
    // Exact match, word-normalized or squished (so "pin24" == "Pin 24").
    if (n === qn || (nsq && nsq === qsq)) return 3;
    // Whole-word / whole-phrase containment (never an interior substring — that is
    // what let "verno" match "goVERNOrs Island"), plus a squished PREFIX match so
    // "cloud9" still offers "Cloud9World" without resurrecting the substring bug.
    if (wholeWordMatch(raw, term) || wholeWordMatch(term, raw)) return 2;
    if (nsq && qsq && (nsq.startsWith(qsq) || qsq.startsWith(nsq))) return 2;
    return recordDomains(c).length ? 1 : 0;
  };

  // Find deal_flow entries among candidates; prefer the best name match.
  const dealHits: { company: any; entryId: string }[] = [];
  for (const c of candidateCompanies) {
    const entries = await recordEntries(COMPANIES_OBJECT, recordId(c));
    const de = entries.find((e) => e.list_api_slug === DEAL_FLOW_SLUG);
    if (de) dealHits.push({ company: c, entryId: de.entry_id });
  }
  // An email/domain match is the strongest signal — rank those deal entries first.
  const emailBonus = (c: any) => (emailMatchedIds.has(recordId(c)) ? 10 : 0);
  dealHits.sort(
    (a, b) =>
      emailBonus(b.company) + nameScore(b.company) - (emailBonus(a.company) + nameScore(a.company))
  );

  const dealEntryId = dealHits[0]?.entryId;
  const dealParentCompanyId = dealHits[0] ? recordId(dealHits[0].company) : undefined;

  let dealFlow: DealFlow | undefined;
  if (dealEntryId) {
    const entry = await getDealFlowEntry(dealEntryId);
    const ev = entry?.entry_values || {};
    const introRef = first(ev.intro_d_by);
    dealFlow = {
      status: statusVal(ev.status),
      introDByType: selectVal(ev.intro_d_by_type),
      introDById: introRef?.target_record_id
        ? { object: introRef.target_object, recordId: introRef.target_record_id }
        : undefined,
      verticals: selectVal(ev.verticals),
      location: selectVal(ev.location),
      dateFounded: dateVal(ev.date_founded),
      ceoLinkedin: textVal(ev.ceo_linkedin),
      ctoLinkedin: textVal(ev.cto_linkedin),
      dealFolder: textVal(ev.deal_folder),
      deckUrl: textVal(ev.deck_url),
      videoLink: textVal(ev.video_link),
      firstMeetingRecording: textVal(ev["1st_meeting_recording"]),
      nextSteps: textVal(ev.next_steps),
      reasonForPass: textVal(ev.reason_for_pass),
      capitalRaised: currencyVal(ev.capital_raised),
      capitalRaising: currencyVal(ev.capital_raising),
      sourcedBy: selectVal(ev.sourced_by_2),
      followUpDate: dateVal(ev.follow_up_date),
      dealTags: selectVal(ev.deal_tags),
      companyDomain: textVal(ev.company_domain),
      school: selectVal(ev.school),
    };
    if (dealFlow.introDById) {
      const rec = await getRecord(dealFlow.introDById.object, dealFlow.introDById.recordId);
      if (rec) dealFlow.introDByName = recordName(rec);
      // Is the introducer a real person (→ close-the-loop eligible) and what's
      // their email? A channel stand-in ("List", "LinkedIn") is a companies-object
      // record, not a person.
      const obj = String(dealFlow.introDById.object);
      dealFlow.introDByIsPerson = obj === PEOPLE_OBJECT || /people/i.test(obj);
      if (rec && dealFlow.introDByIsPerson) dealFlow.introDByEmail = recordEmails(rec)[0];
    }
  }

  // Featured company: prefer an email/domain-matched company (strongest signal),
  // then the deal_flow parent, then the best name match.
  const byScore = [...candidateCompanies].sort((a, b) => nameScore(b) - nameScore(a));
  const emailMatched = candidateCompanies.filter((c) => emailMatchedIds.has(recordId(c)));
  const featured =
    emailMatched.find((c) => recordId(c) === dealParentCompanyId) ||
    emailMatched[0] ||
    candidateCompanies.find((c) => recordId(c) === dealParentCompanyId) ||
    byScore[0];
  const featuredId = recordId(featured);

  // People, anchored to the featured company only:
  //  (a) the featured company's team links,
  //  (b) people from the name search whose linked company IS the featured company,
  //  (c) the plausible founder-people themselves (founder-name query).
  const peopleMap = new Map<string, ResolvedPerson>();
  const addPerson = (rec: any, roleFallback?: string) => {
    const id = recordId(rec);
    if (!id || peopleMap.has(id)) return;
    const emails = recordEmails(rec);
    // Attio often has nameless "stub" people (enriched from an email only). Recover
    // a display name from the email rather than showing "Unknown"; skip only if
    // there's neither a name nor an email to go on.
    const name = recordName(rec) || nameFromEmail(emails[0]);
    if (!name) return;
    peopleMap.set(id, {
      name,
      recordId: id,
      emails,
      linkedin: textVal(rec.values?.linkedin),
      jobTitle: selectVal(rec.values?.job_title) || textVal(rec.values?.job_title) || roleFallback,
    });
  };

  const teamIds = new Set<string>();
  for (const t of featured.values?.team || []) {
    if (t?.target_record_id) teamIds.add(t.target_record_id);
  }
  const teamRecs = await Promise.all([...teamIds].map((id) => getRecord(PEOPLE_OBJECT, id)));
  for (const r of teamRecs) if (r) addPerson(r);

  for (const p of peopleHits) {
    if (first(p.values?.company)?.target_record_id === featuredId) addPerson(p);
  }
  for (const p of plausiblePeople) addPerson(p);

  const people = [...peopleMap.values()];

  // Enrich people using the deal_flow CEO/CTO LinkedIn URLs: assign the role and,
  // when the slug is splittable (e.g. "natalie-curnes"), upgrade the display name.
  // This is what turns a nameless "rooshil@…" stub into "Rooshil — CEO".
  const ceoSlug = linkedinSlug(dealFlow?.ceoLinkedin);
  const ctoSlug = linkedinSlug(dealFlow?.ctoLinkedin);
  let ceoPersonName: string | undefined;
  for (const p of people) {
    const nameLooksDerived = /^[A-Z][a-z]+$/.test(p.name); // single word from an email
    if (ceoSlug && personMatchesSlug(p.emails, p.name, ceoSlug)) {
      p.jobTitle = p.jobTitle || "CEO";
      if (nameLooksDerived) p.name = nameFromSlug(ceoSlug) || p.name;
      p.linkedin = p.linkedin || dealFlow?.ceoLinkedin;
      ceoPersonName = p.name;
    } else if (ctoSlug && personMatchesSlug(p.emails, p.name, ctoSlug)) {
      p.jobTitle = p.jobTitle || "CTO";
      if (nameLooksDerived) p.name = nameFromSlug(ctoSlug) || p.name;
      p.linkedin = p.linkedin || dealFlow?.ctoLinkedin;
    }
  }

  const emails = [...new Set(people.flatMap((p) => p.emails))];

  // Notes on the featured company + each real person record.
  const noteSources: { object: string; id: string }[] = [
    { object: COMPANIES_OBJECT, id: featuredId },
    ...people.map((p) => ({ object: PEOPLE_OBJECT, id: p.recordId })),
  ];
  const noteResults = await Promise.all(noteSources.map((s) => getNotes(s.object, s.id)));
  const notes: AttioNote[] = noteResults.flat().map((n) => ({
    title: n.title || "(untitled note)",
    date: n.created_at,
    extract: noteBodyExtract(n),
    noteId: n.id?.note_id,
    parentObject: n.parent_object,
    parentRecordId: n.parent_record_id,
  }));

  const featuredRawName = recordName(featured) || term;
  const featuredStealth =
    isStealthName(featuredRawName) || recordDomains(featured).length === 0;

  // Founder display name: the CEO if we identified one, else the first real
  // person; otherwise the founder we matched via the CEO LinkedIn slug (the
  // query itself), or, for a stealth deal named for the founder, the company name.
  let founderName: string | undefined = ceoPersonName || people[0]?.name;
  if (!founderName) {
    if (matchedViaLinkedin) founderName = term; // the query is the CEO we matched
    else if (featuredStealth && looksLikePersonName(featuredRawName)) {
      founderName = featuredRawName.replace(/\(.*?\)/g, "").trim();
    }
  }

  // Synthesize a founder for the stealth-named-by-founder case, or when we matched
  // the founder via the CEO LinkedIn slug — never for a real company with no
  // linked person record.
  const displayPeople = [...people];
  if (displayPeople.length === 0 && founderName && (featuredStealth || matchedViaLinkedin)) {
    displayPeople.push({
      name: founderName,
      recordId: "",
      emails: [],
      linkedin: dealFlow?.ceoLinkedin,
      jobTitle: matchedViaLinkedin ? "CEO" : "Founder",
    });
  }

  return {
    found: true,
    featuredCompany: {
      name: featuredRawName,
      recordId: featuredId,
      domain: recordDomains(featured)[0],
      description: textVal(featured.values?.description),
      location:
        dealFlow?.location || first(featured.values?.primary_location)?.locality || undefined,
      founded:
        dealFlow?.dateFounded || dateVal(featured.values?.foundation_date) || undefined,
      fundingRaised: currencyVal(featured.values?.funding_raised_usd),
      isStealth: featuredStealth,
      webUrl: featured.web_url,
    },
    founderName,
    dealFlowEntryId: dealEntryId,
    allCompanyRecordIds: candidateCompanies.map((c) => recordId(c)),
    people: displayPeople,
    emails,
    dealFlow,
    notes,
    lastInteractionAt: lastInteractionAt(featured),
    nextMeetingAt: calInteractionAt(featured, "next_calendar_interaction"),
    lastMeetingAt: calInteractionAt(featured, "last_calendar_interaction"),
    candidatesConsidered: candidateCompanies.length,
  };
}

export interface CompanyCandidate {
  name: string;
  recordId: string;
  domain?: string;
  description?: string;
  location?: string;
  isStealth: boolean;
  webUrl?: string;
  hasDeal: boolean;
  status?: string;
}

/**
 * Lightweight probe for disambiguation: the company records that plausibly match
 * the query by NAME (plus companies linked from a matching founder-person). No
 * people/notes/Grain — just enough to show the user a picker when several close
 * records exist (e.g. two "Etched" records). Returns [] for email/unique queries.
 */
export async function findCandidates(
  query: string,
  opts: { emailHints?: string[] } = {}
): Promise<CompanyCandidate[]> {
  const term = cleanTerm(query) || query.trim();
  if (!term || query.includes("@")) return []; // email queries resolve uniquely
  const qn = normName(term);
  const qsq = squish(term);
  const queryIsPerson = looksLikePersonName(query);

  const [companyHits, peopleHits] = await Promise.all([
    searchByName(COMPANIES_OBJECT, term),
    searchByName(PEOPLE_OBJECT, term),
  ]);
  const companyById = new Map<string, any>();
  for (const c of companyHits) companyById.set(recordId(c), c);

  // Companies linked from a plausible founder-person (founder-name queries).
  if (queryIsPerson) {
    const linked = new Set<string>();
    for (const p of peopleHits) {
      const raw = recordName(p) || "";
      if (!normName(raw).includes(qn) && !(qsq.length >= 4 && squish(raw).includes(qsq))) continue;
      const cid = first(p.values?.company)?.target_record_id;
      if (cid && !companyById.has(cid)) linked.add(cid);
    }
    const recs = await Promise.all([...linked].map((id) => getRecord(COMPANIES_OBJECT, id)));
    for (const c of recs) if (c) companyById.set(recordId(c), c);
  }

  const nameScore = (c: any): number => {
    const raw = recordName(c) || "";
    const n = normName(raw);
    const nsq = squish(raw);
    // Exact (word-normalized or squished so "pin24" == "Pin 24").
    if (n === qn || (nsq && nsq === qsq)) return 3;
    // Whole-word/phrase containment or a squished prefix — but NOT an interior
    // substring, which would wrongly offer "Governors Island" for "verno".
    if (wholeWordMatch(raw, term) || wholeWordMatch(term, raw)) return 2;
    if (nsq && qsq && (nsq.startsWith(qsq) || qsq.startsWith(nsq))) return 2;
    return 0;
  };
  // Only close name matches are disambiguation candidates. Collapse near-identical
  // records — same name AND same (or no) domain — that would render as duplicate,
  // unpickable rows (Attio often holds several imports of one company); keep the
  // richest. Records that share a name but differ by domain stay separate, since
  // they may be genuinely different companies (e.g. two "Etched").
  const richness = (x: any): number =>
    (textVal(x.values?.description) ? 2 : 0) + (recordDomains(x).length ? 1 : 0);
  const bestByKey = new Map<string, any>();
  for (const c of [...companyById.values()].filter((x) => nameScore(x) >= 2)) {
    const key = `${squish(recordName(c) || "")}|${(recordDomains(c)[0] || "").toLowerCase()}`;
    const cur = bestByKey.get(key);
    if (!cur || richness(c) > richness(cur)) bestByKey.set(key, c);
  }
  const strong = [...bestByKey.values()]
    .sort((a, b) => nameScore(b) - nameScore(a))
    .slice(0, 6);

  // Attach deal_flow status for each (so the picker can show it).
  const out: CompanyCandidate[] = [];
  for (const c of strong) {
    const entries = await recordEntries(COMPANIES_OBJECT, recordId(c));
    const de = entries.find((e) => e.list_api_slug === DEAL_FLOW_SLUG);
    let status: string | undefined;
    if (de) {
      const entry = await getDealFlowEntry(de.entry_id);
      status = statusVal(entry?.entry_values?.status);
    }
    const rawName = recordName(c) || term;
    out.push({
      name: rawName,
      recordId: recordId(c),
      domain: recordDomains(c)[0],
      description: textVal(c.values?.description),
      location: first(c.values?.primary_location)?.locality || undefined,
      isStealth: isStealthName(rawName) || recordDomains(c).length === 0,
      webUrl: c.web_url,
      hasDeal: !!de,
      status,
    });
  }
  // Deals first, then by name-match strength.
  out.sort((a, b) => Number(b.hasDeal) - Number(a.hasDeal));
  return out;
}

export interface DealByStatus {
  entryId: string;
  recordId: string; // parent company record
  createdAt?: string;
}

/**
 * All deal_flow entries currently in a given pipeline status (e.g. "To Pass"),
 * newest first. Returns the list entry id (to write status back) and the parent
 * company record id (to resolve the full context). Paginates the whole set.
 */
export async function listDealsByStatus(status: string, cap = 200): Promise<DealByStatus[]> {
  const out: DealByStatus[] = [];
  let offset = 0;
  while (out.length < cap) {
    let data: any[] = [];
    try {
      const r = await api(`/lists/${DEAL_FLOW_SLUG}/entries/query`, {
        filter: { status },
        limit: 50,
        offset,
      });
      data = r.data || [];
    } catch {
      break;
    }
    if (!data.length) break;
    for (const e of data) {
      const entryId = e.id?.entry_id || e.entry_id;
      const rid = e.parent_record_id;
      if (entryId && rid) out.push({ entryId, recordId: rid, createdAt: e.created_at });
    }
    if (data.length < 50) break;
    offset += 50;
  }
  return out;
}

/** Name + first email for a single person record (the introducer, resolved for
 *  the close-the-loop email). Returns undefined fields when the record or email
 *  is missing. */
export async function getPersonContact(
  recordIdStr: string
): Promise<{ name?: string; email?: string }> {
  const rec = await getRecord(PEOPLE_OBJECT, recordIdStr);
  if (!rec) return {};
  return { name: recordName(rec), email: recordEmails(rec)[0] };
}
