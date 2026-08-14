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

/** Step 1 of the skill, as deterministic API calls. */
export async function resolveEntity(query: string): Promise<AttioResolution> {
  const term = cleanTerm(query) || query.trim();

  // Fire company + people searches together.
  const [companyHits, peopleHits] = await Promise.all([
    searchRecords(COMPANIES_OBJECT, term),
    searchRecords(PEOPLE_OBJECT, term),
  ]);

  // People: collect emails + linked company ids.
  const people: ResolvedPerson[] = peopleHits.map((p) => ({
    name: recordName(p) || "Unknown",
    recordId: recordId(p),
    emails: recordEmails(p),
    linkedin: textVal(p.values?.linkedin),
    jobTitle: selectVal(p.values?.job_title) || textVal(p.values?.job_title),
  }));

  const linkedCompanyIds = new Set<string>();
  for (const p of peopleHits) {
    const c = first(p.values?.company);
    if (c?.target_record_id) linkedCompanyIds.add(c.target_record_id);
  }

  // Union candidate company records: direct hits + companies linked from people.
  const companyById = new Map<string, any>();
  for (const c of companyHits) companyById.set(recordId(c), c);
  const missingLinked = [...linkedCompanyIds].filter((id) => !companyById.has(id));
  const linkedFetched = await Promise.all(
    missingLinked.map((id) => getRecord(COMPANIES_OBJECT, id))
  );
  for (const c of linkedFetched) if (c) companyById.set(recordId(c), c);

  const candidateCompanies = [...companyById.values()];

  // Pull team members from each candidate company to catch co-founders' emails.
  const teamPersonIds = new Set<string>();
  for (const c of candidateCompanies) {
    const team = c.values?.team;
    if (Array.isArray(team)) {
      for (const t of team) if (t?.target_record_id) teamPersonIds.add(t.target_record_id);
    }
  }
  const knownPersonIds = new Set(people.map((p) => p.recordId));
  const missingTeam = [...teamPersonIds].filter((id) => !knownPersonIds.has(id));
  const teamFetched = await Promise.all(
    missingTeam.map((id) => getRecord(PEOPLE_OBJECT, id))
  );
  for (const p of teamFetched) {
    if (!p) continue;
    people.push({
      name: recordName(p) || "Unknown",
      recordId: recordId(p),
      emails: recordEmails(p),
      linkedin: textVal(p.values?.linkedin),
      jobTitle: selectVal(p.values?.job_title) || textVal(p.values?.job_title),
    });
  }

  const emails = [...new Set(people.flatMap((p) => p.emails))];

  // Find the deal_flow entry: walk every candidate company's list entries.
  let dealEntryId: string | undefined;
  let dealParentCompanyId: string | undefined;
  for (const c of candidateCompanies) {
    const entries = await recordEntries(COMPANIES_OBJECT, recordId(c));
    const de = entries.find((e) => e.list_api_slug === DEAL_FLOW_SLUG);
    if (de) {
      dealEntryId = de.entry_id;
      dealParentCompanyId = recordId(c);
      break;
    }
  }

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

    // Resolve the intro-source record reference to a name.
    if (dealFlow.introDById) {
      const rec = await getRecord(dealFlow.introDById.object, dealFlow.introDById.recordId);
      if (rec) dealFlow.introDByName = recordName(rec);
    }
  }

  if (candidateCompanies.length === 0 && people.length === 0) {
    return {
      found: false,
      allCompanyRecordIds: [],
      people: [],
      emails: [],
      notes: [],
      candidatesConsidered: 0,
    };
  }

  // Pick the featured company: prefer the deal_flow parent, else a real-domain
  // record, else the most recently interacted, else the first.
  const withRealDomain = candidateCompanies.filter((c) => recordDomains(c).length > 0);
  const featured =
    candidateCompanies.find((c) => recordId(c) === dealParentCompanyId) ||
    withRealDomain[0] ||
    candidateCompanies[0];

  // Notes on the featured company + each real person record (before we add any
  // synthetic founder, which has no record to query notes on).
  const noteSources: { object: string; id: string }[] = [];
  if (featured) noteSources.push({ object: COMPANIES_OBJECT, id: recordId(featured) });
  for (const p of people) noteSources.push({ object: PEOPLE_OBJECT, id: p.recordId });
  const noteResults = await Promise.all(
    noteSources.map((s) => getNotes(s.object, s.id))
  );
  const notes: AttioNote[] = noteResults.flat().map((n) => ({
    title: n.title || "(untitled note)",
    date: n.created_at,
    extract: noteBodyExtract(n),
  }));

  const featuredRawName = featured ? recordName(featured) || term : term;
  const featuredStealth =
    !!featured && (isStealthName(featuredRawName) || recordDomains(featured).length === 0);

  // Determine the founder's display name. Prefer a real person; otherwise, for a
  // stealth deal the founder IS the company record's name (minus "(Stealth)").
  let founderName: string | undefined = people[0]?.name;
  if (!founderName && featured && looksLikePersonName(featuredRawName)) {
    founderName = featuredRawName.replace(/\(.*?\)/g, "").trim();
  }

  // If no person record exists but we recovered a founder name, synthesize one so
  // the founder still surfaces (with their CEO LinkedIn from the deal_flow entry).
  const displayPeople = [...people];
  if (displayPeople.length === 0 && founderName) {
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
    featuredCompany: featured
      ? {
          name: featuredRawName,
          recordId: recordId(featured),
          domain: recordDomains(featured)[0],
          description: textVal(featured.values?.description),
          location:
            dealFlow?.location ||
            first(featured.values?.primary_location)?.locality ||
            undefined,
          founded:
            dealFlow?.dateFounded ||
            dateVal(featured.values?.foundation_date) ||
            undefined,
          fundingRaised: currencyVal(featured.values?.funding_raised_usd),
          isStealth: featuredStealth,
        }
      : undefined,
    founderName,
    allCompanyRecordIds: candidateCompanies.map((c) => recordId(c)),
    people: displayPeople,
    emails,
    dealFlow,
    notes,
    lastInteractionAt: featured ? lastInteractionAt(featured) : undefined,
    candidatesConsidered: candidateCompanies.length,
  };
}
