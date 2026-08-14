// Attio REST client — the retrieval layer for the company-search app.
// Implements Step 1 of the skill (resolve the entity) directly against the API:
// search companies AND people by name, union candidate company records, collect
// every email, and find the deal_flow entry by walking each candidate record's
// list entries. Read-only.

const BASE = "https://api.attio.com/v2";

const COMPANIES_OBJECT = "5d5f1d54-8b3d-4b70-9419-bed8c153dff6";
const PEOPLE_OBJECT = "399c6054-a063-4fe3-bb75-ac9b18bc0354";
const DEAL_FLOW_SLUG = "deal_flow";

function key(): string {
  const k = process.env.ATTIO_API_KEY;
  if (!k) throw new Error("ATTIO_API_KEY is not set (add it to .env.local)");
  return k;
}

async function api(path: string, body?: unknown): Promise<any> {
  const res = await fetch(BASE + path, {
    method: body === undefined ? "GET" : "POST",
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

// ---------- API primitives ----------

async function searchRecords(object: string, term: string, limit = 25): Promise<any[]> {
  const r = await api(`/objects/${object}/records/query`, {
    filter: { name: { $contains: term } },
    limit,
  });
  return r.data || [];
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
  };
  /** The founder's display name (from a person record, or the stealth company name). */
  founderName?: string;
  allCompanyRecordIds: string[];
  people: ResolvedPerson[];
  emails: string[];
  dealFlow?: DealFlow;
  notes: AttioNote[];
  lastInteractionAt?: string;
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
export async function resolveEntity(query: string): Promise<AttioResolution> {
  const term = cleanTerm(query) || query.trim();
  const queryIsPerson = looksLikePersonName(query);
  const qn = normName(term);

  // Fire company + people searches together.
  const [companyHits, peopleHits] = await Promise.all([
    searchRecords(COMPANIES_OBJECT, term),
    searchRecords(PEOPLE_OBJECT, term),
  ]);

  // People are only "plausibly the founder" when the query itself is a person
  // name AND the record's full name actually contains it — this is what keeps
  // "verno" from matching "Vernon Gair".
  const plausiblePeople = queryIsPerson
    ? peopleHits.filter((p) => normName(recordName(p) || "").includes(qn))
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
  // when several match (e.g. the real "Verno" over "Governors Island").
  const nameScore = (c: any): number => {
    const n = normName(recordName(c) || "");
    if (n === qn) return 3;
    if (n.includes(qn) || qn.includes(n)) return 2;
    return recordDomains(c).length ? 1 : 0;
  };

  // Find deal_flow entries among candidates; prefer the best name match.
  const dealHits: { company: any; entryId: string }[] = [];
  for (const c of candidateCompanies) {
    const entries = await recordEntries(COMPANIES_OBJECT, recordId(c));
    const de = entries.find((e) => e.list_api_slug === DEAL_FLOW_SLUG);
    if (de) dealHits.push({ company: c, entryId: de.entry_id });
  }
  dealHits.sort((a, b) => nameScore(b.company) - nameScore(a.company));

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
    }
  }

  // Featured company: the deal_flow parent, else the best name match.
  const byScore = [...candidateCompanies].sort((a, b) => nameScore(b) - nameScore(a));
  const featured =
    candidateCompanies.find((c) => recordId(c) === dealParentCompanyId) || byScore[0];
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
  }));

  const featuredRawName = recordName(featured) || term;
  const featuredStealth =
    isStealthName(featuredRawName) || recordDomains(featured).length === 0;

  // Founder display name: the CEO if we identified one, else the first real
  // person; otherwise, for a stealth deal whose company record is named for the
  // founder, the cleaned company name.
  let founderName: string | undefined = ceoPersonName || people[0]?.name;
  if (!founderName && featuredStealth && looksLikePersonName(featuredRawName)) {
    founderName = featuredRawName.replace(/\(.*?\)/g, "").trim();
  }

  // Synthesize a founder ONLY for the stealth-named-by-founder case — never for a
  // real company that simply has no linked person record.
  const displayPeople = [...people];
  if (displayPeople.length === 0 && founderName && featuredStealth) {
    displayPeople.push({
      name: founderName,
      recordId: "",
      emails: [],
      linkedin: dealFlow?.ceoLinkedin,
      jobTitle: "Founder",
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
    },
    founderName,
    allCompanyRecordIds: candidateCompanies.map((c) => recordId(c)),
    people: displayPeople,
    emails,
    dealFlow,
    notes,
    lastInteractionAt: lastInteractionAt(featured),
    candidatesConsidered: candidateCompanies.length,
  };
}
