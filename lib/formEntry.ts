// Form Entry — the post-meeting "First Meeting Deal Feedback" drafter.
//
// Deterministic port of the deal-feedback skill: for each first meeting that
// already happened in the last few days, resolve the Attio record and draft the
// form's factual fields, then build a link that opens the REAL Airtable form
// with those values pre-filled. Never writes to Airtable — the user reviews the
// pre-filled form and submits it himself. The judgment fields (Recommendation,
// Tags, Other Notes) are always left for the user, exactly as the skill does.

import { resolveEntity, AttioResolution, DealFlow } from "./attio";
import { getPastDaysMeetings, companyTermsForEmail, DayMeeting } from "./suggestions";
import { resolveGrain, getTranscript } from "./grain";
import { draftNotes, extractEquity } from "./notesDraft";
import { normalize } from "./match";
import {
  FormEntryList,
  FormEntryMeeting,
  FormDraftResponse,
  FormField,
} from "./types";

// The First Meeting Deal Feedback form (base appV89PYGo3zN47f9 / page pagkSiTFZMfvNHv5F).
// Prefill works via ?prefill_<Field Name>=<value>; linked-record fields need the
// linked record's id, plain fields take the value, Type is a hidden default.
const FORM_URL = "https://airtable.com/appV89PYGo3zN47f9/pagkSiTFZMfvNHv5F/form";
const REC_ZANN = "recCOpIMsLT3Wtag9"; // "Zann Ali" — always Your Name
const REC_ALEX = "recoHo9N77Ev8VZPS"; // "Alex Iskold" — always Feedback From

// Exact Airtable option names (some carry a trailing space — prefill matches the
// literal option name, so we keep it and trim only for display).
const RECOMMENDATION_OPTIONS = [
  "Pursue ASAP ",
  "Pursue",
  "Pass ",
  "Watch",
  "Still Thinking",
  "Thesis Opportunity",
];
const TAGS_OPTIONS = [
  "Talent",
  "FMF",
  "Traction",
  "General Thesis",
  "Specific Thesis",
  "Thesis Potential",
  "Space We Like",
  "Space Potential",
];
const MAX_NOTE_BULLETS = 5;

const INTERNAL_DOMAIN = "2048.vc";
const GENERIC_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "yahoo.com",
  "icloud.com", "me.com", "proton.me", "protonmail.com", "aol.com",
]);
const isCompanyDomain = (email: string): boolean => {
  const dom = email.split("@")[1]?.toLowerCase();
  return !!dom && !GENERIC_DOMAINS.has(dom) && !/\.(edu|ac\.[a-z]{2})$/.test(dom);
};

const cleanName = (name: string): string =>
  name.replace(/\s*\(stealth\)\s*/i, "").trim() || name;

const titleCaseWords = (s: string): string => s.replace(/\b[a-z]/g, (m) => m.toUpperCase());

/** A rough company name from an email domain: interlock-systems.io → "Interlock Systems". */
function companyFromEmail(email?: string): string | undefined {
  const dom = email?.split("@")[1]?.toLowerCase();
  if (!dom || GENERIC_DOMAINS.has(dom) || /\.(edu|ac\.[a-z]{2})$/.test(dom)) return undefined;
  const root = dom.split(".")[0].replace(/[-_]+/g, " ").trim();
  return root ? titleCaseWords(root) : undefined;
}

/** A person name from an email local part: t.mangini@… → "T Mangini". */
function nameFromEmailLocal(email?: string): string | undefined {
  const local = email?.split("@")[0];
  if (!local) return undefined;
  const parts = local.split(/[._-]+/).filter((p) => p && !/^\d+$/.test(p) && p.length > 1);
  return parts.length ? titleCaseWords(parts.join(" ")) : undefined;
}

/** Resolve a meeting to its Attio record, same priority order as Meeting Prep. */
async function resolveToAttio(
  m: DayMeeting
): Promise<{ attio: AttioResolution; attendeeName?: string } | null> {
  const externals = m.attendees.filter((a) => {
    const dom = (a.email || "").split("@")[1]?.toLowerCase();
    return dom && dom !== INTERNAL_DOMAIN;
  });
  const emailHints = externals.map((a) => a.email!).filter(Boolean);
  const attendeeName =
    externals.find((a) => a.name && /\s/.test(a.name))?.name ||
    externals.find((a) => a.name)?.name;

  const tryResolve = async (term: string, hints: string[]) => {
    try {
      const a = await resolveEntity(term, { emailHints: hints });
      return a.found && a.featuredCompany ? a : null;
    } catch {
      return null;
    }
  };

  let attio: AttioResolution | null = null;
  // 1. Company-domain email — the strongest, unambiguous key.
  for (const email of emailHints.filter(isCompanyDomain)) {
    attio = await tryResolve(email, [email]);
    if (attio) break;
  }
  // 2. Personal/school email → cross-reference the person's other meetings.
  if (!attio) {
    for (const email of emailHints) {
      const terms = await companyTermsForEmail(email);
      for (const t of terms.slice(0, 4)) {
        attio = await tryResolve(t, [email]);
        if (attio) break;
      }
      if (attio) break;
    }
  }
  // 3. Last resort: the meeting title.
  if (!attio) attio = await tryResolve(m.term, emailHints);

  return attio ? { attio, attendeeName } : null;
}

const externalAttendees = (m: DayMeeting) =>
  m.attendees.filter((a) => {
    const dom = (a.email || "").split("@")[1]?.toLowerCase();
    return dom && dom !== INTERNAL_DOMAIN;
  });

const daysApart = (a: string, b: string): number =>
  Math.abs((Date.parse(a + "T00:00:00") - Date.parse(b + "T00:00:00")) / 864e5);

interface GrainMatch {
  url?: string;
  points: string[]; // the call's summary bullets, for seeding Other Notes
  transcript?: string; // full transcript, for equity extraction
}

/** Find the Grain recording for THIS meeting (we don't populate Attio's
 *  1st_meeting_recording field). Match by attendee email, then meeting date,
 *  then fall back to the most recent recording for the company. Returns the
 *  share url and the call's summary points. */
async function findGrainMatch(
  attio: AttioResolution,
  m: DayMeeting,
  emailHints: string[],
  meetingDate: string
): Promise<GrainMatch> {
  const terms = [
    attio.featuredCompany?.name.replace(/\(.*?\)/g, "").trim(),
    attio.founderName,
    m.term,
  ].filter(Boolean) as string[];
  try {
    const { recordings } = await resolveGrain(terms);
    if (recordings.length === 0) return { points: [] };

    // 1) A recording whose participants include an external attendee — the
    // strongest, timezone-independent match.
    const emailSet = new Set(emailHints.map((e) => e.toLowerCase()));
    const byEmail = recordings.find((r) =>
      r.participants.some((p) => p.email && emailSet.has(p.email.toLowerCase()))
    );
    // 2) Same day (±1 to absorb UTC-vs-local date roll on evening calls).
    const byDate = recordings.find((r) => r.date && daysApart(r.date.slice(0, 10), meetingDate) <= 1);
    // 3) It's a first meeting, so the newest match is almost certainly this one.
    const pick = byEmail || byDate || recordings[0];
    const transcript = await getTranscript(pick.id);
    return { url: pick.url, points: pick.summaryPoints || [], transcript };
  } catch {
    return { points: [] };
  }
}

/** "Rob Blaine, Community" | channel-only "LinkedIn" — the skill's intro format. */
function introdBy(d?: DealFlow): string | undefined {
  if (!d) return undefined;
  const name = d.introDByName?.trim();
  const type = d.introDByType?.trim();
  // A channel stand-in (a "person" record literally named for the channel) or a
  // name that just duplicates the type → collapse to the single channel/type.
  if (name && type && normalize(name) !== normalize(type)) return `${name}, ${type}`;
  if (name && !type) return name;
  return type || undefined;
}

/** Normalize an Attio record web_url to the overview page. */
function attioOverview(attio: AttioResolution): string | undefined {
  const c = attio.featuredCompany;
  if (!c) return undefined;
  if (c.webUrl) {
    return /\/(company|person)\/[^/]+$/.test(c.webUrl) ? `${c.webUrl}/overview` : c.webUrl;
  }
  return `https://app.attio.com/2048-ventures/company/${c.recordId}/overview`;
}

const liSlug = (url?: string): string =>
  url ? url.match(/\/in\/([^/?#]+)/i)?.[1]?.toLowerCase() || url.toLowerCase() : "";

// Internal noise a meeting title/attendee list sometimes injects as a "founder".
const isInternalName = (name?: string): boolean => !!name && /2048/i.test(name);

interface FounderEntry {
  name: string;
  li?: string;
}

/** The founder list, deduped and capped. Pulls BOTH the company's linked people
 *  AND the deal's CEO/CTO LinkedIn — the co-founder is often only on the deal_flow
 *  cto_linkedin field, not a person record. */
function founderEntries(attio: AttioResolution, fallbackName?: string): FounderEntry[] {
  const d = attio.dealFlow;
  const seen = new Set<string>();
  const entries: FounderEntry[] = [];
  const add = (name?: string, li?: string) => {
    if (!name && !li) return;
    const key = li ? `li:${liSlug(li)}` : `nm:${normalize(name || "")}`;
    if (seen.has(key)) return;
    seen.add(key);
    entries.push({ name: name || nameFromSlug(liSlug(li || "")) || "Founder", li });
  };

  // 1) People linked to the company (attach their role's LinkedIn if missing).
  for (const p of attio.people) {
    if (isInternalName(p.name)) continue;
    let li = p.linkedin;
    const R = (p.jobTitle || "").toUpperCase();
    if (!li && R.includes("CEO")) li = d?.ceoLinkedin;
    if (!li && R.includes("CTO")) li = d?.ctoLinkedin;
    add(p.name, li);
  }
  // 2) Deal-flow CEO + CTO LinkedIn — co-founders who may not be person records.
  //    Derive the name from the slug (e.g. /in/oliver-wesche → "Oliver Wesche").
  for (const li of [d?.ceoLinkedin, d?.ctoLinkedin]) {
    if (li && !seen.has(`li:${liSlug(li)}`)) add(nameFromSlug(liSlug(li)), li);
  }
  // 3) Nothing linked at all — fall back to the resolved / attendee founder.
  if (entries.length === 0) {
    const solo = attio.founderName || (!isInternalName(fallbackName) ? fallbackName : undefined);
    if (solo) add(solo, d?.ceoLinkedin);
  }
  return entries.slice(0, 6);
}

/** Match an extracted-equity key to a founder by first name token. */
function equityFor(equity: Record<string, string>, name: string): string | undefined {
  const first = normalize(name).split(" ")[0];
  if (!first) return undefined;
  for (const [k, v] of Object.entries(equity)) {
    if (normalize(k).split(" ")[0] === first) return v;
  }
  return undefined;
}

/** Format founders as "Name - linkedin (equity)", one per line. Equity is
 *  appended only when the call stated it (from extractEquity). */
function formatFounders(
  entries: FounderEntry[],
  equity: Record<string, string>
): string | undefined {
  if (entries.length === 0) return undefined;
  return entries
    .map((e) => {
      const base = e.li ? `${e.name} - ${e.li}` : `${e.name} — no LinkedIn on file`;
      const eq = equityFor(equity, e.name);
      return eq ? `${base} (${eq})` : base;
    })
    .join("\n");
}

/** "oliver-wesche" → "Oliver Wesche"; a single concatenated token → undefined. */
function nameFromSlug(slug: string): string | undefined {
  const parts = slug.split(/[-.]+/).filter((p) => p && !/\d/.test(p) && p.length > 1);
  if (parts.length < 2) return undefined;
  return parts.map((p) => p[0].toUpperCase() + p.slice(1)).join(" ");
}

function roundLine(d?: DealFlow): string | undefined {
  if (!d) return undefined;
  if (d.capitalRaising) return `Raising ${d.capitalRaising}`;
  if (d.capitalRaised) return `Raised ${d.capitalRaised}`;
  return undefined;
}

/** A few call bullets from Grain's own summary, as a starting Other Notes draft.
 *  Dash-prefixed lines to match how the notes render in Airtable's rich-text field. */
function notesSeed(points: string[]): string | undefined {
  const lines = points
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(0, MAX_NOTE_BULLETS)
    .map((p) => `- ${p}`);
  return lines.length ? lines.join("\n") : undefined;
}

/** Build the drafted form fields + the pre-filled Airtable link.
 *  The prefill URL here is the BASE — factual + fixed fields only. Recommendation,
 *  Tags and Other Notes are interactive, so the client appends those choices. */
async function buildDraft(
  attio: AttioResolution,
  founderFallback?: string,
  grain?: GrainMatch
): Promise<{ fields: FormField[]; prefillUrl: string }> {
  const c = attio.featuredCompany!;
  const d = attio.dealFlow;

  const company = cleanName(c.name);
  const description = c.description;
  const deck = d?.deckUrl;
  // The Grain recording found by lookup (we don't rely on Attio's field).
  const grainLink = grain?.url || d?.firstMeetingRecording;
  const attioLink = attioOverview(attio);
  const intro = introdBy(d);
  // Founders, with equity appended when the call stated it (pulled from the transcript).
  const founderList = founderEntries(attio, founderFallback);
  const equity = await extractEquity(grain?.transcript, founderList.map((e) => e.name));
  const founders = formatFounders(founderList, equity);
  const round = roundLine(d);
  // Other Notes: LLM draft in Zann's voice when a key is set, else Grain bullets.
  const styled = await draftNotes({
    company,
    founder: (founderFallback && !isInternalName(founderFallback) ? founderFallback : undefined) || attio.founderName,
    description,
    callPoints: grain?.points || [],
  });
  const notes = styled || notesSeed(grain?.points || []);

  // prefill query params — factual + fixed fields only; the interactive fields
  // (Recommendation / Tags / Other Notes) are appended client-side on change.
  const prefill = new URLSearchParams();
  prefill.append("prefill_Your Name", REC_ZANN);
  prefill.append("prefill_Feedback From", REC_ALEX);
  const add = (fieldName: string, value?: string) => {
    if (value) prefill.append(`prefill_${fieldName}`, value);
  };
  add("Company Name", company);
  add("Quick Description", description);
  add("Deck Link", deck);
  add("Grain Link", grainLink);
  add("Attio Link", attioLink);
  add("Intro'd By + Type", intro);
  // Airtable prefill keeps line breaks — one founder per line.
  add("Founders", founders);
  add("Round", round);
  prefill.append("prefill_Type", "General");
  const prefillUrl = `${FORM_URL}?${prefill.toString()}`;

  const factual = (label: string, value?: string, blankReason?: string): FormField =>
    value ? { label, value } : { label, blankReason: blankReason || "not on file in Attio" };

  const fields: FormField[] = [
    { label: "Your Name", value: "Zann Ali" },
    { label: "Feedback From", value: "Alex Iskold" },
    factual("Company Name", company),
    factual("Quick Description", description),
    factual("Deck Link", deck),
    factual("Grain Link", grainLink, "no matching Grain recording found"),
    factual("Attio Link", attioLink),
    factual("Intro'd By + Type", intro, "no intro on the deal_flow entry"),
    { label: "Recommendation", control: "select", options: RECOMMENDATION_OPTIONS, prefillField: "Recommendation" },
    { label: "Tags", control: "multiselect", options: TAGS_OPTIONS, prefillField: "Tags" },
    factual("Founders", founders, "no founder / LinkedIn on file"),
    factual("Round", round, "round not captured in Attio"),
    {
      label: "Other Notes / Analysis",
      control: "longtext",
      value: notes,
      prefillField: "Other Notes / Analysis",
    },
  ];

  return { fields, prefillUrl };
}

/** The pick-list: recent external meetings that already happened. Lightweight —
 *  just the calendar scan, NO Attio/Grain resolution (that's done per meeting,
 *  on demand, only when the user clicks Draft). */
export async function listRecentMeetings(numDays = 3): Promise<FormEntryList> {
  const { configured, meetings } = await getPastDaysMeetings(numDays);
  if (!configured) return { configured: false, meetings: [] };
  return {
    configured: true,
    meetings: meetings.map(({ date, m }) => {
      const ext = externalAttendees(m);
      // The person we met (calendar name preferred, else derived from the email),
      // and a company guessed from the email domain — the title-derived term is
      // often an internal name (e.g. "Zann Ali") so it's only a last resort.
      const person =
        ext.find((a) => a.name && /\s/.test(a.name))?.name ||
        ext.find((a) => a.name)?.name ||
        nameFromEmailLocal(ext[0]?.email);
      const company =
        companyFromEmail(ext[0]?.email) ||
        (m.term && !isInternalName(m.term) && normalize(m.term) !== normalize(person || "")
          ? m.term
          : undefined);
      return {
        date,
        time: m.time,
        title: m.title,
        person,
        company,
        term: m.term,
        attendees: ext.map((a) => ({ name: a.name, email: a.email })),
      };
    }),
  };
}

export interface DraftInput {
  date: string;
  time?: string;
  title: string;
  term: string;
  attendees: { name?: string; email?: string }[];
}

/** Draft the feedback form for ONE chosen meeting: resolve → Grain → build. */
export async function draftMeeting(input: DraftInput): Promise<FormDraftResponse> {
  const m: DayMeeting = {
    term: input.term,
    title: input.title,
    time: input.time,
    upcoming: false,
    startISO: `${input.date}T${input.time || "00:00"}:00`,
    attendees: input.attendees,
  };
  const emailHints = externalAttendees(m).map((a) => a.email!).filter(Boolean);

  const resolved = await resolveToAttio(m);
  if (!resolved) {
    return { resolved: false, note: "Couldn't match this meeting to an Attio record." };
  }

  const company = cleanName(resolved.attio.featuredCompany!.name);
  const grain = await findGrainMatch(resolved.attio, m, emailHints, input.date);
  const draft = await buildDraft(resolved.attio, resolved.attendeeName, grain);

  const rawFounder = resolved.attendeeName || resolved.attio.founderName;
  const founder = isInternalName(rawFounder) ? resolved.attio.founderName : rawFounder;

  // A record with no deal_flow entry usually isn't a pipeline deal (law firm,
  // vendor) — draft it anyway, but flag it so the user can sanity-check.
  const note = resolved.attio.dealFlowEntryId
    ? undefined
    : "Not in the deal pipeline (no deal_flow entry) — double-check this is the right record.";

  const meeting: FormEntryMeeting = {
    date: input.date,
    time: input.time,
    title: input.title,
    company,
    founder: founder && !company.includes(founder) ? founder : undefined,
    attendees: externalAttendees(m).map((a) => ({ name: a.name, email: a.email })),
    fields: draft.fields,
    prefillUrl: draft.prefillUrl,
  };
  return { resolved: true, note, meeting };
}
