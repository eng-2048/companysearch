// Assembles the Context Bundle by merging Attio (structured deal data) with
// Grain (recordings, transcripts, and — crucially — the founder identity and
// emails that Attio's structured fields often lack). Calendar + email are still
// to come; they're flagged as gaps.

import { AttioResolution, resolveEntity } from "./attio";
import { GrainResolution, resolveGrain, GrainRecordingData } from "./grain";
import { CalendarResolution, resolveCalendar, calendarConfigured } from "./gcal";
import { EmailResolution, resolveEmail, gmailConfigured } from "./gmail";
import { normalize, to12h } from "./match";
import {
  ContextBundle,
  Gap,
  GrainRecording,
  Meeting,
  Person,
  Sourced,
  TimelineEntry,
} from "./types";

const today = () => new Date().toISOString().slice(0, 10);

const GENERIC_EMAIL_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "yahoo.com",
  "icloud.com", "me.com", "proton.me", "protonmail.com", "aol.com",
]);

function sourced(value: string | undefined, source: Sourced["sources"][number]): Sourced {
  if (value) return { value, sources: [source] };
  return { value: "", sources: ["unknown"] };
}

/** Infer a company domain from a founder email (skip personal + school domains). */
function inferDomain(emails: string[]): string | undefined {
  for (const e of emails) {
    const dom = e.split("@")[1]?.toLowerCase();
    if (!dom) continue;
    if (GENERIC_EMAIL_DOMAINS.has(dom)) continue;
    if (/\.(edu|ac\.[a-z]{2})$/.test(dom)) continue;
    return dom;
  }
  return undefined;
}

function mergePeople(attio: AttioResolution, grain: GrainResolution): Person[] {
  const people: Person[] = attio.people.map((p) => ({
    name: p.name,
    role: p.jobTitle,
    emails: p.emails,
    sources: ["attio"],
  }));

  // Add Grain-discovered external people not already present (by email or name).
  for (const gp of grain.externalPeople) {
    const dup = people.find(
      (p) =>
        (gp.email && p.emails.includes(gp.email)) ||
        normalize(p.name) === normalize(gp.name)
    );
    if (dup) {
      if (gp.email && !dup.emails.includes(gp.email)) dup.emails.push(gp.email);
      if (!dup.sources.includes("grain")) dup.sources.push("grain");
      // Upgrade an email-derived name ("Rooshil") to Grain's fuller one
      // ("Rooshil Shah") when it clearly extends the same name.
      const dupTokens = normalize(dup.name).split(" ").filter(Boolean);
      const gpTokens = normalize(gp.name).split(" ").filter(Boolean);
      if (
        gpTokens.length > dupTokens.length &&
        dupTokens.every((t) => gpTokens.includes(t))
      ) {
        dup.name = gp.name;
      }
    } else {
      // Don't presume a title — they were external participants in a recorded
      // meeting; the [grain] tag says where they came from.
      people.push({
        name: gp.name,
        emails: gp.email ? [gp.email] : [],
        sources: ["grain"],
      });
    }
  }
  return people;
}

function toGrainRecordings(recs: GrainRecordingData[]): GrainRecording[] {
  return recs.map((r) => ({
    title: r.title,
    id: r.id,
    url: r.url,
    date: r.date ? r.date.slice(0, 10) : "",
    duration: r.durationMin ? `${r.durationMin} min` : undefined,
    summary: r.summary,
    keyPoints: r.summaryPoints.map((p) => ({ point: p })),
  }));
}

function fmtDateTime(iso?: string): string {
  if (!iso) return "";
  const m = iso.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})/);
  // Show the event's wall-clock time in 12-hour form. (No tz label: calendar
  // events are already in local time; a "UTC" suffix here was misleading.)
  return m ? `${m[1]} · ${to12h(`${m[2]}:${m[3]}`)}` : iso.slice(0, 10);
}

function notFound(query: string): ContextBundle {
  return {
    company: query,
    founder: query,
    generated: today(),
    sourcesChecked: ["Attio", "Grain"],
    regime: "upcoming",
    summary: `Nothing found for "${query}" in Attio or Grain. Try the founder's full name, or the company name/domain.`,
    identity: { company: query },
    links: {},
    people: [],
    timeline: [],
    meetings: [],
    grainRecordings: [],
    attioNotes: [],
    gaps: [
      {
        description: `No Attio record and no Grain recording matched "${query}"`,
        resolution: "Check spelling, or try the founder's full name / the company domain",
      },
    ],
  };
}

export async function gatherContext(
  query: string,
  opts: { attioOnly?: boolean; emailHints?: string[]; recordId?: string } = {}
): Promise<ContextBundle> {
  const attio = await resolveEntity(query, {
    emailHints: opts.emailHints,
    recordId: opts.recordId,
  });

  // A bare first name ("Ben") as a Grain/Calendar term matches every unrelated
  // "Ben …" recording, so only search by the founder when it's a full name.
  const isFullName = (n?: string): boolean =>
    !!n && n.trim().split(/\s+/).filter(Boolean).length >= 2;

  // Build Grain search terms from whatever we now know.
  const terms: string[] = [];
  if (attio.found && attio.featuredCompany) {
    terms.push(attio.featuredCompany.name.replace(/\(.*?\)/g, "").trim());
    if (isFullName(attio.founderName)) terms.push(attio.founderName!);
  }
  terms.push(query.replace(/\(.*?\)/g, "").trim());

  // Prep mode (attioOnly) skips the heavy Grain/Calendar/Email passes — it only
  // needs identity + links, and runs once per meeting so speed matters.
  let grain: GrainResolution = { recordings: [], externalPeople: [], emails: [] };
  let grainError: string | undefined;
  if (!opts.attioOnly) {
    try {
      grain = await resolveGrain(terms);
    } catch (e: any) {
      grainError = e?.message || "Grain lookup failed";
    }
  }

  if (!attio.found && grain.recordings.length === 0) return notFound(query);

  const c = attio.featuredCompany;
  const d = attio.dealFlow;

  const people = mergePeople(attio, grain);
  const allEmails = [...new Set(people.flatMap((p) => p.emails))];

  let founder =
    attio.founderName || grain.externalPeople[0]?.name || people[0]?.name || c?.name || query;
  const company = c?.name || query;
  const domain = c?.domain || inferDomain(allEmails);

  const grainRecordings = toGrainRecordings(grain.recordings);
  // --- Google Calendar (recent past + upcoming) ---
  const calTerms = [
    company.replace(/\(.*?\)/g, "").trim(),
    isFullName(founder) ? founder : undefined,
  ].filter(Boolean) as string[];
  let calendar: CalendarResolution = { events: [], configured: calendarConfigured() };
  let calError: string | undefined;
  try {
    if (!opts.attioOnly) calendar = await resolveCalendar(calTerms, allEmails);
  } catch (e: any) {
    calError = e?.message || "Calendar lookup failed";
  }

  const todayStr = today();

  // --- Reconcile meetings: a Grain recording and a calendar event are ONE meeting
  //     when they share a day and an attendee email. Merge, don't duplicate. ---
  const meetings: Meeting[] = grain.recordings.map((r) => ({
    datetime: fmtDateTime(r.date),
    title: r.title,
    attendees: r.participants.map((p) => ({ name: p.name, email: p.email })),
    recordingUrl: r.url,
    upcoming: false, // a recorded meeting already happened
    startISO: r.date,
    sources: ["grain"],
  }));
  for (const ev of calendar.events) {
    const day = ev.startISO.slice(0, 10);
    const evEmails = new Set(
      ev.attendees.map((a) => (a.email || "").toLowerCase()).filter(Boolean)
    );
    const attendees = ev.attendees.map((a) => ({
      name: a.name,
      email: a.email,
      optional: a.optional,
      rsvp: a.responseStatus,
    }));
    const match = meetings.find(
      (m) =>
        m.datetime.startsWith(day) &&
        m.attendees.some((a) => a.email && evEmails.has(a.email.toLowerCase()))
    );
    if (match) {
      match.attendees = attendees; // richer: RSVP + optional flags from calendar
      if (!match.sources.includes("cal")) match.sources.push("cal");
    } else {
      meetings.push({
        datetime: fmtDateTime(ev.startISO),
        title: ev.title,
        attendees,
        recordingUrl: undefined,
        upcoming: ev.upcoming,
        startISO: ev.startISO,
        sources: ["cal"],
      });
    }
  }
  const startMs = (m: Meeting) => (m.startISO ? new Date(m.startISO).getTime() : 0);
  meetings.sort((a, b) => startMs(a) - startMs(b));

  // Attach an Attio note to the meeting it belongs to (matched by date), and
  // build a deep-link that opens the note in its record's Notes tab. Attio
  // doesn't return a note web_url, so construct one from the workspace base in
  // the company record's web_url:
  //   {workspace}/{company|person}/{parent_record_id}/notes?id={note_id}&modal=note
  const workspaceBase = c?.webUrl ? c.webUrl.split("/company/")[0] : undefined;
  const noteUrl = (n: (typeof attio.notes)[number]): string | undefined => {
    if (!workspaceBase || !n.noteId || !n.parentRecordId) return undefined;
    const seg = n.parentObject === "people" ? "person" : "company";
    return `${workspaceBase}/${seg}/${n.parentRecordId}/notes?id=${n.noteId}&modal=note`;
  };
  for (const m of meetings) {
    const day = m.startISO?.slice(0, 10);
    if (!day) continue;
    const note = attio.notes.find((n) => n.noteId && n.date?.slice(0, 10) === day);
    if (note) m.notesUrl = noteUrl(note);
  }

  // --- Timeline, derived from the reconciled meetings (+ Attio fallbacks) ---
  const timeline: TimelineEntry[] = meetings.map((m) => ({
    date: m.datetime.slice(0, 10),
    type: m.upcoming ? "upcoming" : "meeting",
    summary: `${m.upcoming ? "Upcoming meeting" : "Meeting"} — "${m.title}"`,
    sources: m.sources,
  }));
  // Fall back to Attio's aggregate calendar signal only when Google isn't giving events.
  if (!calendar.configured || calendar.events.length === 0) {
    const nextDay = attio.nextMeetingAt?.slice(0, 10);
    if (nextDay && nextDay >= todayStr)
      timeline.push({ date: nextDay, type: "upcoming", summary: "Upcoming meeting on the calendar", sources: ["cal"] });
    if (attio.lastMeetingAt && grain.recordings.length === 0)
      timeline.push({ date: attio.lastMeetingAt.slice(0, 10), type: "meeting", summary: "Most recent calendar meeting", sources: ["cal"] });
  }
  if (attio.lastInteractionAt && meetings.length === 0) {
    timeline.push({
      date: attio.lastInteractionAt.slice(0, 10),
      type: "interaction",
      summary: "Most recent recorded interaction (Attio aggregate)",
      sources: ["attio"],
    });
  }
  timeline.sort((a, b) => b.date.localeCompare(a.date));

  const upcomingMeetings = meetings.filter((m) => m.upcoming);
  const nextMeetingDay =
    upcomingMeetings[0]?.datetime.slice(0, 10) ||
    (attio.nextMeetingAt && attio.nextMeetingAt.slice(0, 10) >= todayStr
      ? attio.nextMeetingAt.slice(0, 10)
      : undefined);

  const hasPast =
    meetings.some((m) => !m.upcoming) || grain.recordings.length > 0;
  const regime: ContextBundle["regime"] =
    hasPast ||
    !!attio.lastInteractionAt ||
    !!d?.firstMeetingRecording ||
    (!!d?.status && !/^(new|inbound|to review|n\/a)$/i.test(d.status))
      ? "past"
      : "upcoming";

  // Upgrade person + founder names from calendar attendee display names — the
  // calendar often carries the full name ("Rooshil Shah") where Attio had none.
  const calNameByEmail = new Map<string, string>();
  for (const ev of calendar.events) {
    for (const a of ev.attendees) {
      if (a.email && a.name) {
        const e = a.email.toLowerCase();
        const cur = calNameByEmail.get(e);
        if (!cur || a.name.split(/\s+/).length > cur.split(/\s+/).length) {
          calNameByEmail.set(e, a.name);
        }
      }
    }
  }
  for (const p of people) {
    const cn = p.emails.map((e) => calNameByEmail.get(e.toLowerCase())).find(Boolean);
    if (!cn) continue;
    const pT = normalize(p.name).split(" ").filter(Boolean);
    const cT = normalize(cn).split(" ").filter(Boolean);
    if (cT.length > pT.length && pT.every((t) => cT.includes(t))) {
      p.name = cn;
      if (!p.sources.includes("cal")) p.sources.push("cal");
    }
  }
  const ceoName = people.find((p) => (p.role || "").toUpperCase() === "CEO")?.name;
  if (ceoName) {
    founder = ceoName;
  } else {
    const fT = normalize(founder).split(" ").filter(Boolean);
    const fp = people.find((p) => {
      const pT = normalize(p.name).split(" ").filter(Boolean);
      return fT.length && pT.length >= fT.length && fT.every((t) => pT.includes(t));
    });
    if (fp) founder = fp.name;
  }

  // --- Email thread (native Gmail) ---
  // Search the founder/team addresses: people emails + external attendees on the
  // matched meetings + external Grain participants.
  const emailSearchSet = new Set(allEmails.map((e) => e.toLowerCase()));
  for (const ev of calendar.events)
    for (const a of ev.attendees) {
      const dom = (a.email || "").split("@")[1]?.toLowerCase();
      if (a.email && dom && dom !== "2048.vc") emailSearchSet.add(a.email.toLowerCase());
    }
  for (const r of grain.recordings)
    for (const p of r.participants)
      if (p.email && p.external) emailSearchSet.add(p.email.toLowerCase());

  let email: EmailResolution = { configured: gmailConfigured(), available: false, messages: [] };
  let emailError: string | undefined;
  if (!opts.attioOnly) {
    try {
      email = await resolveEmail([...emailSearchSet]);
    } catch (e: any) {
      emailError = e?.message || "Email lookup failed";
    }
  }
  const emailThread =
    email.messages.length > 0
      ? {
          messages: email.messages.map((m) => ({
            date: m.date,
            from: m.fromName,
            to: m.to,
            oneLine: m.subject,
          })),
          intro: email.intro,
          outcome: email.outcome,
        }
      : undefined;

  const introSource: Sourced | undefined =
    d?.introDByName || d?.introDByType
      ? {
          value: [d?.introDByName, d?.introDByType].filter(Boolean).join(" · "),
          sources: ["attio"],
        }
      : undefined;

  // Summary
  const sp: string[] = [];
  if (c?.description) sp.push(`${company} — ${c.description}${c.location ? ` (${c.location})` : ""}.`);
  else sp.push(`${company}.`);
  const names = people.slice(0, 3).map((p) => p.name).join(", ");
  if (names) sp.push(`People: ${names}.`);
  if (d?.status) sp.push(`Pipeline status: ${d.status}.`);
  if (introSource) sp.push(`Intro: ${introSource.value}.`);
  if (d?.capitalRaising) sp.push(`Raising ${d.capitalRaising}.`);
  else if (d?.capitalRaised) sp.push(`Raised ${d.capitalRaised}.`);
  if (grain.recordings.length)
    sp.push(`${grain.recordings.length} Grain recording${grain.recordings.length > 1 ? "s" : ""} on file.`);
  if (nextMeetingDay && nextMeetingDay >= todayStr) sp.push(`Next meeting: ${nextMeetingDay}.`);
  if (d?.nextSteps) sp.push(`Next steps: ${d.nextSteps}.`);
  const summary = sp.join(" ");

  // Links — Attio first, Grain recording as fallback for the recording link.
  const grainRecUrl = grain.recordings[0]?.url;
  const links = {
    website: sourced(domain ? `https://${domain}` : undefined, c?.domain ? "attio" : "grain"),
    deck: sourced(d?.deckUrl, "attio"),
    dealFolder: sourced(d?.dealFolder, "attio"),
    ceoLinkedin: sourced(d?.ceoLinkedin, "attio"),
    ctoLinkedin: sourced(d?.ctoLinkedin, "attio"),
    recording:
      d?.videoLink || d?.firstMeetingRecording
        ? sourced(d?.videoLink || d?.firstMeetingRecording, "attio")
        : sourced(grainRecUrl, "grain"),
    attioRecord: sourced(c?.webUrl, "attio"),
  };

  // Gaps — honest about what's still not wired.
  const gaps: Gap[] = [];
  if (!calendar.configured) {
    gaps.push({
      description: "Google Calendar isn't connected yet",
      resolution: "Run scripts/google-auth.mjs to add the full meeting list (attendees + RSVPs)",
    });
  }
  if (!email.available) {
    gaps.push({
      description: "Gmail isn't connected yet",
      resolution: "Enable the Gmail API + re-run scripts/google-auth.mjs for the email thread",
    });
  }
  if (calError) {
    gaps.push({ description: `Calendar lookup failed: ${calError}`, resolution: "Check the Google credentials / refresh token" });
  }
  if (emailError) {
    gaps.push({ description: `Email lookup failed: ${emailError}`, resolution: "Check the Gmail scope / API" });
  }
  if (grainError) {
    gaps.push({ description: `Grain lookup failed: ${grainError}`, resolution: "Check the GRAIN_PAT token" });
  }
  if (attio.found && !d) {
    gaps.push({
      description: "No deal_flow entry found among candidate records",
      resolution: `Searched ${attio.candidatesConsidered} company record(s)`,
    });
  }
  if (people.length === 0) {
    gaps.push({
      description: "Founder not identifiable from Attio or Grain",
      resolution: "May surface from the email thread or the deck once connected",
    });
  }

  const sourcesChecked = [
    attio.found ? "Attio" : null,
    "Grain",
    calendar.configured ? "Calendar" : null,
    email.available ? "Email" : null,
  ].filter(Boolean) as string[];

  return {
    company,
    founder,
    generated: today(),
    sourcesChecked,
    regime,
    summary,
    identity: {
      company,
      description: c?.description,
      domain,
      attioCompanyId: c?.recordId,
      dealFlowEntryId: attio.dealFlowEntryId,
      attioPeopleIds: attio.people.map((p) => ({ name: p.name, id: p.recordId })),
      pipelineStatus: d?.status ? { value: d.status, sources: ["attio"] } : undefined,
      sourcedBy: d?.sourcedBy,
      verticals: d?.verticals ? [d.verticals] : undefined,
      location: c?.location,
      founded: c?.founded,
      capitalRaised: d?.capitalRaised || c?.fundingRaised,
      capitalRaising: d?.capitalRaising,
    },
    links,
    people,
    introSource,
    timeline,
    meetings,
    grainRecordings,
    emailThread,
    attioNotes: attio.notes,
    gaps,
  };
}
