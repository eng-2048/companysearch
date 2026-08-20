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
import { normalize } from "./match";
import {
  resolveToAttio,
  findGrainMatch,
  externalAttendees,
  GrainMatch,
} from "./formEntry";
import { draftPassEmail, draftCloseLoop, draftWatchEmail } from "./passDraft";
import {
  EMAIL_TEST_MODE,
  TEST_RECIPIENT,
  senderEmail,
  findLatestThread,
  resolveEmail,
  scanPriorOutreach,
} from "./gmail";
import {
  PassFollowUpList,
  PassItem,
  PassRecipient,
  PassIntroducer,
  PassMeetingRef,
  PassEmailDraft,
  PassDraftResponse,
  PassThreadPreview,
} from "./types";

const DEFAULT_SUBJECT = "Follow Up From 2048 Ventures";
// Scope To Pass to Zann's own deals (the pipeline is shared across the team).
const ZANN_MEMBER_ID = "8a182b51-6194-4b04-85e0-991657cfe9db";
// Resolve at most this many To Pass deals per load (newest first) so the first
// uncached scan stays responsive; the true total is surfaced separately.
const MAX_TO_PASS_RESOLVE = 40;
const MAX_TO_PASS_FETCH = 300;

// Recent meetings in these states are done deals (won, dead, or being tracked
// separately) — not follow-up candidates, so they're dropped from the list.
const DROP_RECENT_STATUS = /\b(pass|closed|closing|lost|watch)\b/i;

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

const liSlug = (url?: string): string | undefined =>
  url ? url.match(/\/in\/([^/?#]+)/i)?.[1]?.toLowerCase() : undefined;

/** "oliver-wesche-1234" → "Oliver Wesche"; a single concatenated token → undefined. */
function nameFromSlug(slug?: string): string | undefined {
  if (!slug) return undefined;
  const parts = slug.split(/[-.]+/).filter((p) => p && !/\d/.test(p) && p.length > 1);
  if (parts.length < 2) return undefined;
  return parts.map((p) => p[0].toUpperCase() + p.slice(1)).join(" ");
}

const isCeoRole = (role?: string) => /ceo|chief executive|founder/i.test(role || "");

/** A real personal name (not an email handle like "tglasgow") — gates whether we
 *  greet by first name and whether the recipient counts as confirmed. */
function looksLikeRealName(name?: string, email?: string): boolean {
  const n = (name || "").trim();
  if (!n || n.includes("@")) return false;
  const local = (email || "").split("@")[0].toLowerCase();
  if (n.toLowerCase() === local) return false; // it's just the email handle
  if (/\s/.test(n)) return true; // multi-word name
  return /^[A-Za-z][a-z]+$/.test(n) && n.toLowerCase() !== local; // proper single first name
}

/**
 * Deduce the CEO recipient across every source we have — Attio people, the deal's
 * CEO LinkedIn slug (name + email match), and any extra contacts from the Grain
 * call / calendar attendees. Always returns something to show; `verified` is true
 * only when we're confident about BOTH the person and an email. When it stays
 * ambiguous, the email is left blank (the UI flags it) rather than guessed wrong.
 */
function deduceRecipient(
  attio: AttioResolution,
  extras: { name?: string; email?: string }[] = []
): PassRecipient {
  type C = { name?: string; email: string; role?: string };
  const pool: C[] = [];
  const seen = new Set<string>();
  const push = (name?: string, email?: string, role?: string) => {
    const e = (email || "").trim().toLowerCase();
    if (!e.includes("@") || e.endsWith("@2048.vc")) return;
    const existing = pool.find((c) => c.email === e);
    if (existing) {
      if (name && !existing.name) existing.name = name;
      if (role && !existing.role) existing.role = role;
      return;
    }
    if (seen.has(e)) return;
    seen.add(e);
    pool.push({ name, email: e, role });
  };
  for (const p of attio.people || []) push(p.name, p.emails?.[0], p.jobTitle);
  // Team/linked contacts from Attio (includes nameless stubs like "j@company.com"
  // that `people` drops — often the founder we want).
  for (const c of attio.contactEmails || []) push(c.name, c.email, c.role);
  for (const x of extras) push(x.name, x.email);

  // The CEO's name — a CEO-tagged person, else the resolved founder, else the
  // name derived from the deal's CEO LinkedIn slug (this is the Lykos case).
  const ceoSlug = liSlug(attio.dealFlow?.ceoLinkedin);
  const ceoNameFromSlug = nameFromSlug(ceoSlug);
  const ceoPerson = (attio.people || []).find((p) => isCeoRole(p.jobTitle));
  const founderClean =
    attio.founderName && !attio.featuredCompany?.name.includes(attio.founderName)
      ? attio.founderName
      : undefined;
  const ceoName = ceoPerson?.name || founderClean || ceoNameFromSlug;

  // Pick the email, most confident signal first.
  let chosen: C | undefined;
  let verified = false;

  // 1) A CEO/founder-tagged Attio person who has an email.
  const ceoWithEmail = (attio.people || []).find((p) => isCeoRole(p.jobTitle) && p.emails?.[0]);
  if (ceoWithEmail) {
    chosen = { name: ceoWithEmail.name, email: ceoWithEmail.emails[0], role: ceoWithEmail.jobTitle };
    verified = true;
  }
  // 2) The CEO LinkedIn slug matches an email's local part (…/in/aurnovcy ~ aurnov@…).
  if (!chosen && ceoSlug) {
    const s = ceoSlug.replace(/[^a-z0-9]/g, "");
    chosen = pool.find((c) => {
      const local = c.email.split("@")[0].replace(/[^a-z0-9]/g, "");
      return local.length >= 3 && (s.includes(local) || local.includes(s));
    });
    if (chosen) verified = true;
  }
  // 3) The CEO name shares a distinctive token with a candidate's name.
  if (!chosen && ceoName) {
    const toks = normalize(ceoName).split(" ").filter((t) => t.length >= 3);
    chosen = pool.find(
      (c) => c.name && toks.some((t) => normalize(c.name!).split(" ").includes(t))
    );
    if (chosen) verified = true;
  }
  // 4) Exactly one external contact across all sources — almost certainly the founder.
  if (!chosen && pool.length === 1) {
    chosen = pool[0];
    verified = true;
  }

  const candidates = pool.map((c) => ({ name: c.name || c.email, email: c.email, role: c.role }));
  const name = chosen?.name || ceoName || "";
  // Confident only with an email AND a REAL name — if we found an email but can't
  // name the person (a bare "j@company.com", or a handle like "tglasgow"), leave
  // it flagged so Zann checks and the greeting stays neutral.
  return {
    name,
    email: chosen?.email,
    role: chosen?.role,
    verified: verified && !!chosen?.email && looksLikeRealName(name, chosen?.email),
    candidates,
  };
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

  // A display label for the intro, ALWAYS (even for List/LinkedIn channels, which
  // aren't close-the-loop eligible) so the user can see whether a loop is owed.
  const d = attio.dealFlow;
  const introName = d?.introDByName?.trim();
  const introType = d?.introDByType?.trim();
  const introText =
    introName && introType && normalize(introName) !== normalize(introType)
      ? `${introName} · ${introType}`
      : introName || introType || undefined;

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
    recipient: deduceRecipient(attio, opts.meeting?.attendees || []),
    closeLoopEligible: eligible,
    introducer,
    introText,
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
  const allDeals = await listDealsByStatus("To Pass", MAX_TO_PASS_FETCH, ZANN_MEMBER_ID);
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
    // Only actual pipeline deals: a resolved company without a deal_flow entry
    // (a VC firm, a law firm, a vendor) isn't a follow-up candidate.
    if (!item.dealFlowEntryId) continue;
    // Drop done deals (Pass / Closed / Closing / Lost / Watch) and de-dupe against
    // the To Pass section.
    if (DROP_RECENT_STATUS.test(item.status || "")) continue;
    if (seen.has(item.recordId)) continue;
    seen.add(item.recordId);
    recent.push(item);
  }

  return { configured: true, ...base, toPass, toPassTotal, recent };
}

// ————————————————————————————————— Drafting —————————————————————————————————

export interface PassDraftRequest {
  kind: "pass" | "close" | "watch";
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
    return { url: pick.url, points: pick.summaryPoints || [], transcript, participants: pick.participants };
  } catch {
    return { points: [] };
  }
}

/** Contacts to feed CEO deduction: external Grain participants + meeting attendees. */
function extraContacts(grain: GrainMatch, meeting?: PassMeetingRef): { name?: string; email?: string }[] {
  const out: { name?: string; email?: string }[] = [];
  for (const p of grain.participants || []) {
    if (p.external !== false && p.email) out.push({ name: p.name, email: p.email });
  }
  for (const a of meeting?.attendees || []) out.push({ name: a.name, email: a.email });
  return out;
}

/** The latest email thread with these addresses, plus a short message preview —
 *  shown at the review step so the user can see what they'd be replying to. */
export async function getThreadPreview(emails: string[]): Promise<PassThreadPreview> {
  const clean = [...new Set(emails.map((e) => e.trim().toLowerCase()).filter((e) => e.includes("@")))];
  if (!clean.length) return { found: false, messages: [] };

  const [thread, mail] = await Promise.all([findLatestThread(clean), resolveEmail(clean)]);
  const toMsg = (m: any) => ({
    date: m.date,
    who: `${m.fromName}${m.fromEmail?.endsWith("@2048.vc") ? " (2048)" : ""}`,
    subject: m.subject,
    snippet: m.snippet,
  });

  if (!thread) {
    return { found: false, messages: (mail.messages || []).slice(-6).map(toMsg) };
  }
  const subject = thread.subject
    ? /^re:/i.test(thread.subject)
      ? thread.subject
      : `Re: ${thread.subject}`
    : "Follow Up From 2048 Ventures";
  const messages = (mail.messages || [])
    .filter((m: any) => m.threadId === thread.threadId)
    .slice(-6)
    .map(toMsg);
  return {
    found: true,
    subject,
    threadId: thread.threadId,
    inReplyTo: thread.messageId,
    references: thread.references,
    messages: messages.length ? messages : (mail.messages || []).slice(-6).map(toMsg),
  };
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

  const res =
    req.kind === "close"
      ? await draftClose(attio, company, grain, req)
      : req.kind === "watch"
        ? await draftWatch(attio, company, grain, req)
        : await draftPass(attio, company, grain, req);

  // Look through the mailbox for an email a 2048 address already sent this founder
  // (a pass/watch someone — even a teammate — may have sent manually), so the UI
  // can warn before double-sending.
  if (res.ok && res.draft) {
    const scanEmails =
      req.kind === "close"
        ? res.draft.to.map((a) => a.email).filter(Boolean)
        : [...res.draft.to.map((a) => a.email), ...(attio.emails || [])].filter(Boolean);
    try {
      const prior = await scanPriorOutreach(scanEmails);
      if (prior) res.priorOutreach = prior;
    } catch {
      /* mailbox scan is best-effort */
    }
  }
  return res;
}

// Drafting produces the body + recipient + a default (fresh) subject only.
// Choosing fresh-vs-reply and looking up the thread happens later, at the review
// step (see the /thread route), so the user can see the thread before sending.
async function draftPass(
  attio: AttioResolution,
  company: string,
  grain: GrainMatch,
  req: PassDraftRequest
): Promise<PassDraftResponse> {
  const recipient = deduceRecipient(attio, extraContacts(grain, req.meeting));
  // Only greet by first name when we actually trust the recipient; otherwise stay
  // neutral ("Hi there,") so the draft doesn't hard-code a wrong name.
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

  const draft: PassEmailDraft = {
    kind: "pass",
    subject: DEFAULT_SUBJECT,
    to: recipient.email ? [{ name: recipient.name, email: recipient.email }] : [],
    cc: [],
    body,
    mode: "fresh",
    grainUrl: grain.url,
  };
  const note = recipient.verified
    ? undefined
    : "Double-check the recipient — I couldn't confirm the CEO's name/email from Attio.";
  return { ok: true, note, draft };
}

async function draftWatch(
  attio: AttioResolution,
  company: string,
  grain: GrainMatch,
  req: PassDraftRequest
): Promise<PassDraftResponse> {
  const recipient = deduceRecipient(attio, extraContacts(grain, req.meeting));
  const founderFirst = recipient.verified ? firstNameOf(recipient.name || attio.founderName) : "";

  const body = await draftWatchEmail({
    company,
    founderFirstName: founderFirst,
    founderFullName: recipient.name || attio.founderName,
    callPoints: grain.points,
    transcript: grain.transcript,
    customInstructions: req.customInstructions,
  });

  const draft: PassEmailDraft = {
    kind: "watch",
    subject: DEFAULT_SUBJECT,
    to: recipient.email ? [{ name: recipient.name, email: recipient.email }] : [],
    cc: [],
    body,
    mode: "fresh",
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

  const founderName = deduceRecipient(attio).name || attio.founderName || company;
  const body = await draftCloseLoop({
    company,
    founderName,
    sourceFirstName: firstNameOf(introducer.name),
    reasons: req.reasons,
    callPoints: grain.points,
    customInstructions: req.customInstructions,
  });

  const draft: PassEmailDraft = {
    kind: "close",
    subject: DEFAULT_SUBJECT,
    to: sourceEmail ? [{ name: introducer.name, email: sourceEmail }] : [],
    cc: [],
    body,
    mode: "fresh",
    grainUrl: grain.url,
  };
  const note = sourceEmail
    ? undefined
    : "No email on file for the introducer — add it before sending.";
  return { ok: true, note, draft };
}
