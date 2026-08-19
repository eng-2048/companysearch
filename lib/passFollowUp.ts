// Pass / Follow-Up — the post-decision workflow. Lists deals queued to pass ("To
// Pass") plus recent meetings, and drafts the two emails Zann sends: the pass
// email to the founder, and the optional "close the loop" email to whoever
// introduced the deal. Drafting pulls the Grain call for light tailoring; sending
// is handled by the send route (gmail.sendGmail, hard-clamped to a test recipient
// while EMAIL_TEST_MODE is on). Nothing here ever sends on its own.

import {
  resolveEntity,
  listDealsByStatus,
  getPersonContact,
  AttioResolution,
} from "./attio";
import { getPastDaysMeetings, DayMeeting } from "./suggestions";
import { resolveGrain, getTranscript } from "./grain";
import {
  resolveToAttio,
  findGrainMatch,
  externalAttendees,
  GrainMatch,
} from "./formEntry";
import { draftPassEmail, draftCloseLoop } from "./passDraft";
import {
  EMAIL_TEST_MODE,
  TEST_RECIPIENT,
  senderEmail,
  findLatestThread,
} from "./gmail";
import {
  PassFollowUpList,
  PassItem,
  PassRecipient,
  PassIntroducer,
  PassMeetingRef,
  PassEmailDraft,
  PassDraftResponse,
} from "./types";

const DEFAULT_SUBJECT = "Follow Up From 2048 Ventures";
// Resolve at most this many To Pass deals per load (newest first) so the first
// uncached scan stays responsive; the true total is surfaced separately.
const MAX_TO_PASS_RESOLVE = 40;
const MAX_TO_PASS_FETCH = 200;

const GENERIC_EMAIL_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "yahoo.com",
  "icloud.com", "me.com", "proton.me", "protonmail.com", "aol.com",
]);

/** A readable company name from an email domain (verno-ai.com → "Verno Ai") —
 *  used only when the resolved record name is itself an email (stealth deals). */
function companyFromEmailish(email?: string): string | undefined {
  const dom = email?.split("@")[1]?.toLowerCase();
  if (!dom || GENERIC_EMAIL_DOMAINS.has(dom)) return undefined;
  const root = dom.split(".")[0].replace(/[-_]+/g, " ").trim();
  return root ? root.replace(/\b[a-z]/g, (m) => m.toUpperCase()) : undefined;
}

// Intro types that are NOT a real person to close the loop with.
const NO_LOOP_TYPES = new Set(["list", "linkedin"]);

const cleanName = (name: string): string =>
  name.replace(/\s*\(stealth\)\s*/i, "").trim() || name;

const firstNameOf = (name?: string): string =>
  (name || "").replace(/\(.*?\)/g, "").trim().split(/\s+/)[0] || "";

function attioUrlFor(attio: AttioResolution): string | undefined {
  const c = attio.featuredCompany;
  if (!c) return undefined;
  if (c.webUrl) return /\/(company|person)\/[^/]+$/.test(c.webUrl) ? `${c.webUrl}/overview` : c.webUrl;
  return `https://app.attio.com/2048-ventures/company/${c.recordId}/overview`;
}

/** Resolve the CEO recipient from an Attio bundle. Always returns something to
 *  show; `verified` is false (→ UI flags it) when we can't confidently pin the
 *  CEO or an email. `candidates` are the other people/emails to pick from. */
function ceoRecipient(attio: AttioResolution): PassRecipient {
  const people = attio.people || [];
  const withEmail = people.filter((p) => p.emails && p.emails[0]);
  const candidates = withEmail.map((p) => ({
    name: p.name,
    email: p.emails[0],
    role: p.jobTitle,
  }));

  const isCeo = (p: (typeof people)[number]) =>
    /ceo|chief executive|founder/i.test(p.jobTitle || "") || p.name === attio.founderName;

  const ceo =
    people.find((p) => isCeo(p) && p.emails && p.emails[0]) ||
    people.find((p) => p.name === attio.founderName) ||
    withEmail[0] ||
    people[0];

  const name = ceo?.name || attio.founderName || "";
  const email = ceo?.emails?.[0];
  const role = ceo?.jobTitle;
  // Confident only when we have a CEO/founder-tagged person AND an email for them.
  const verified = !!(ceo && email && (/ceo|chief executive|founder/i.test(role || "") || ceo.name === attio.founderName));

  return { name, email, role, verified, candidates };
}

function introducerFrom(attio: AttioResolution): {
  introducer?: PassIntroducer;
  eligible: boolean;
} {
  const d = attio.dealFlow;
  if (!d || !d.introDByIsPerson || !d.introDByName) return { eligible: false };
  const type = (d.introDByType || "").toLowerCase();
  if (NO_LOOP_TYPES.has(type)) return { eligible: false };
  return {
    eligible: true,
    introducer: { name: d.introDByName, email: d.introDByEmail, type: d.introDByType },
  };
}

function passItemFromAttio(
  attio: AttioResolution,
  opts: {
    section: "toPass" | "recent";
    entryId?: string;
    date?: string;
    meeting?: PassMeetingRef;
    status?: string; // authoritative status (To Pass rows come from the status query)
  }
): PassItem {
  const c = attio.featuredCompany!;
  let company = cleanName(c.name);
  // Stealth records are sometimes named for the founder's email — show a real name.
  if (company.includes("@")) {
    company = companyFromEmailish(company) || attio.founderName || company;
  }
  const founderRaw = attio.founderName;
  const founder = founderRaw && !company.includes(founderRaw) ? founderRaw : undefined;
  const { introducer, eligible } = introducerFrom(attio);

  return {
    section: opts.section,
    dealFlowEntryId: opts.entryId || attio.dealFlowEntryId,
    recordId: c.recordId,
    company,
    founder,
    status: opts.status || attio.dealFlow?.status,
    date: opts.date || opts.meeting?.date || attio.lastMeetingAt?.slice(0, 10),
    time: opts.meeting?.time,
    description: c.description,
    attioUrl: attioUrlFor(attio),
    recipient: ceoRecipient(attio),
    closeLoopEligible: eligible,
    introducer,
    meeting: opts.meeting,
  };
}

/** The Pass / Follow-Up list: To Pass deals (any age) pinned on top, then the
 *  last N days of meetings that aren't already Pass / already in the To Pass set.
 *  Attio-only (no Grain / LLM) so it's cheap; the whole thing is day-cached. */
export async function listPassFollowUp(numDays = 10): Promise<PassFollowUpList> {
  let sender: string | undefined;
  try {
    sender = await senderEmail();
  } catch {
    /* Gmail not reachable — list still works, sending just won't */
  }

  const base = {
    testMode: EMAIL_TEST_MODE,
    testRecipient: TEST_RECIPIENT,
    sender,
  };

  // ——— To Pass deals (any age) ———
  // Fetch the whole set (to report the true total), newest first, then resolve
  // only the top slice so the first uncached scan stays responsive.
  const allDeals = await listDealsByStatus("To Pass", MAX_TO_PASS_FETCH);
  const toPassTotal = allDeals.length;
  const sortedDeals = [...allDeals].sort((a, b) =>
    String(b.createdAt || "").localeCompare(String(a.createdAt || ""))
  );
  const toPass = (
    await Promise.all(
      sortedDeals.slice(0, MAX_TO_PASS_RESOLVE).map(async (d) => {
        try {
          const attio = await resolveEntity("", { recordId: d.recordId });
          if (!attio.found || !attio.featuredCompany) return null;
          return passItemFromAttio(attio, {
            section: "toPass",
            entryId: d.entryId,
            date: d.createdAt?.slice(0, 10),
            status: "To Pass",
          });
        } catch {
          return null;
        }
      })
    )
  ).filter(Boolean) as PassItem[];

  // ——— Recent meetings (exclude already-Pass and anything already in To Pass) ———
  const { configured, meetings } = await getPastDaysMeetings(numDays);
  if (!configured) {
    return { configured: false, ...base, toPass, toPassTotal, recent: [] };
  }

  const seen = new Set(toPass.map((i) => i.recordId));
  const recent: PassItem[] = [];
  const resolvedRecent = await Promise.all(
    meetings.map(async ({ date, m }: { date: string; m: DayMeeting }) => {
      try {
        const r = await resolveToAttio(m);
        if (!r || !r.attio.featuredCompany) return null;
        const meetingRef: PassMeetingRef = {
          date,
          time: m.time,
          title: m.title,
          term: m.term,
          attendees: externalAttendees(m).map((a) => ({ name: a.name, email: a.email })),
        };
        return passItemFromAttio(r.attio, { section: "recent", date, meeting: meetingRef });
      } catch {
        return null;
      }
    })
  );
  for (const item of resolvedRecent) {
    if (!item) continue;
    const status = (item.status || "").toLowerCase();
    if (status === "pass") continue; // already passed
    if (seen.has(item.recordId)) continue; // already shown up top / de-dupe
    seen.add(item.recordId);
    recent.push(item);
  }

  return { configured: true, ...base, toPass, toPassTotal, recent };
}

// ————————————————————————————————— Drafting —————————————————————————————————

export interface PassDraftRequest {
  kind: "pass" | "close";
  recordId?: string; // To Pass rows resolve by company record
  meeting?: PassMeetingRef; // recent rows resolve by the meeting
  reasons: string[];
  mode: "fresh" | "reply";
  customInstructions?: string;
}

/** Grain call for a deal: use the meeting when we have one, else the most recent
 *  recording that matches the company/founder. Best effort — returns empty on miss. */
async function grainFor(
  attio: AttioResolution,
  meeting?: PassMeetingRef
): Promise<GrainMatch> {
  if (meeting) {
    const m: DayMeeting = {
      term: meeting.term,
      title: meeting.title,
      time: meeting.time,
      upcoming: false,
      startISO: `${meeting.date}T${meeting.time || "00:00"}:00`,
      attendees: meeting.attendees,
    };
    const hints = meeting.attendees.map((a) => a.email!).filter(Boolean);
    return findGrainMatch(attio, m, hints, meeting.date);
  }
  // No meeting (a To Pass deal) — match Grain by company / founder name.
  const terms = [
    attio.featuredCompany?.name.replace(/\(.*?\)/g, "").trim(),
    attio.founderName,
  ].filter(Boolean) as string[];
  try {
    const { recordings } = await resolveGrain(terms);
    if (!recordings.length) return { points: [] };
    const pick = recordings[0];
    const transcript = await getTranscript(pick.id);
    return { url: pick.url, points: pick.summaryPoints || [], transcript };
  } catch {
    return { points: [] };
  }
}

/** Draft one email (pass to founder, or close-the-loop to the introducer). */
export async function draftEmail(req: PassDraftRequest): Promise<PassDraftResponse> {
  // Resolve the Attio bundle.
  let attio: AttioResolution | null = null;
  if (req.meeting) {
    const m: DayMeeting = {
      term: req.meeting.term,
      title: req.meeting.title,
      time: req.meeting.time,
      upcoming: false,
      startISO: `${req.meeting.date}T${req.meeting.time || "00:00"}:00`,
      attendees: req.meeting.attendees,
    };
    const r = await resolveToAttio(m);
    attio = r?.attio || null;
  } else if (req.recordId) {
    attio = await resolveEntity("", { recordId: req.recordId });
  }
  if (!attio || !attio.featuredCompany) {
    return { ok: false, note: "Couldn't resolve this deal in Attio." };
  }

  const company = cleanName(attio.featuredCompany.name);
  const grain = await grainFor(attio, req.meeting);

  if (req.kind === "pass") {
    return draftPass(attio, company, grain, req);
  }
  return draftClose(attio, company, grain, req);
}

async function draftPass(
  attio: AttioResolution,
  company: string,
  grain: GrainMatch,
  req: PassDraftRequest
): Promise<PassDraftResponse> {
  const recipient = ceoRecipient(attio);
  // Only greet by first name when we actually trust the recipient; otherwise stay
  // neutral ("Hi there,") so the draft doesn't hard-code a wrong name (the company
  // name, an email handle) that the user then has to catch.
  const founderFirst = recipient.verified ? firstNameOf(recipient.name || attio.founderName) : "";

  const body = await draftPassEmail({
    company,
    founderFirstName: founderFirst,
    founderFullName: recipient.name || attio.founderName,
    reasons: req.reasons,
    callPoints: grain.points,
    transcript: grain.transcript,
    customInstructions: req.customInstructions,
  });

  const to = recipient.email ? [{ name: recipient.name, email: recipient.email }] : [];
  let subject = DEFAULT_SUBJECT;
  let threadId: string | undefined;
  let inReplyTo: string | undefined;
  let references: string | undefined;
  let mode = req.mode;

  if (req.mode === "reply") {
    const emails = [
      recipient.email,
      ...(recipient.candidates.map((c) => c.email) || []),
    ].filter(Boolean) as string[];
    const thread = await findLatestThread(emails);
    if (thread) {
      threadId = thread.threadId;
      inReplyTo = thread.messageId;
      references = thread.references;
      subject = thread.subject
        ? /^re:/i.test(thread.subject)
          ? thread.subject
          : `Re: ${thread.subject}`
        : DEFAULT_SUBJECT;
    } else {
      mode = "fresh"; // no thread found — fall back to a fresh email
    }
  }

  const draft: PassEmailDraft = {
    kind: "pass",
    subject,
    to,
    cc: [],
    body,
    mode,
    threadId,
    inReplyTo,
    references,
    grainUrl: grain.url,
  };
  const note = recipient.verified
    ? undefined
    : "Double-check the recipient — I couldn't confirm the CEO's name/email from Attio.";
  return { ok: true, note, draft };
}

async function draftClose(
  attio: AttioResolution,
  company: string,
  grain: GrainMatch,
  req: PassDraftRequest
): Promise<PassDraftResponse> {
  const { introducer, eligible } = introducerFrom(attio);
  if (!eligible || !introducer) {
    return { ok: false, note: "No person to close the loop with on this deal." };
  }

  // The Attio deal_flow intro email may be missing — try the person record again.
  let sourceEmail = introducer.email;
  if (!sourceEmail && attio.dealFlow?.introDById?.recordId) {
    const contact = await getPersonContact(attio.dealFlow.introDById.recordId);
    sourceEmail = contact.email;
  }

  const founderName = ceoRecipient(attio).name || attio.founderName || company;
  const body = await draftCloseLoop({
    company,
    founderName,
    sourceFirstName: firstNameOf(introducer.name),
    reasons: req.reasons,
    callPoints: grain.points,
    customInstructions: req.customInstructions,
  });

  const to = sourceEmail ? [{ name: introducer.name, email: sourceEmail }] : [];
  // Close-the-loop defaults to replying on the original intro thread.
  let subject = `Re: Intro to ${company}`;
  let threadId: string | undefined;
  let inReplyTo: string | undefined;
  let references: string | undefined;
  let mode: "fresh" | "reply" = req.mode;

  if (req.mode === "reply" && sourceEmail) {
    const thread = await findLatestThread([sourceEmail]);
    if (thread) {
      threadId = thread.threadId;
      inReplyTo = thread.messageId;
      references = thread.references;
      subject = thread.subject
        ? /^re:/i.test(thread.subject)
          ? thread.subject
          : `Re: ${thread.subject}`
        : subject;
    } else {
      mode = "fresh";
      subject = DEFAULT_SUBJECT;
    }
  } else if (req.mode === "fresh") {
    subject = DEFAULT_SUBJECT;
  }

  const draft: PassEmailDraft = {
    kind: "close",
    subject,
    to,
    cc: [],
    body,
    mode,
    threadId,
    inReplyTo,
    references,
    grainUrl: grain.url,
  };
  const note = sourceEmail
    ? undefined
    : "No email on file for the introducer — add it before sending.";
  return { ok: true, note, draft };
}
