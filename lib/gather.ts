// Assembles the Context Bundle by merging Attio (structured deal data) with
// Grain (recordings, transcripts, and — crucially — the founder identity and
// emails that Attio's structured fields often lack). Calendar + email are still
// to come; they're flagged as gaps.

import { AttioResolution, resolveEntity } from "./attio";
import { GrainResolution, resolveGrain, GrainRecordingData } from "./grain";
import { normalize } from "./match";
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
  const m = iso.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/);
  return m ? `${m[1]} · ${m[2]} UTC` : iso.slice(0, 10);
}

function toMeetings(recs: GrainRecordingData[]): Meeting[] {
  return recs.map((r) => ({
    datetime: fmtDateTime(r.date),
    title: r.title,
    attendees: r.participants.map((p) => ({
      name: p.name,
      email: p.email,
    })),
    recordingUrl: r.url,
    sources: ["grain"],
  }));
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

export async function gatherContext(query: string): Promise<ContextBundle> {
  const attio = await resolveEntity(query);

  // Build Grain search terms from whatever we now know.
  const terms: string[] = [];
  if (attio.found && attio.featuredCompany) {
    terms.push(attio.featuredCompany.name.replace(/\(.*?\)/g, "").trim());
    if (attio.founderName) terms.push(attio.founderName);
  }
  terms.push(query.replace(/\(.*?\)/g, "").trim());

  let grain: GrainResolution = { recordings: [], externalPeople: [], emails: [] };
  let grainError: string | undefined;
  try {
    grain = await resolveGrain(terms);
  } catch (e: any) {
    grainError = e?.message || "Grain lookup failed";
  }

  if (!attio.found && grain.recordings.length === 0) return notFound(query);

  const c = attio.featuredCompany;
  const d = attio.dealFlow;

  const people = mergePeople(attio, grain);
  const allEmails = [...new Set(people.flatMap((p) => p.emails))];

  const founder =
    attio.founderName || grain.externalPeople[0]?.name || people[0]?.name || c?.name || query;
  const company = c?.name || query;
  const domain = c?.domain || inferDomain(allEmails);

  const grainRecordings = toGrainRecordings(grain.recordings);
  const meetings = toMeetings(grain.recordings);

  // Timeline: Grain meetings + Attio's last-interaction aggregate, newest first.
  const timeline: TimelineEntry[] = [];
  for (const r of grain.recordings) {
    timeline.push({
      date: r.date ? r.date.slice(0, 10) : "",
      type: "meeting",
      summary: `Recorded meeting — "${r.title}"`,
      sources: ["grain"],
    });
  }
  if (attio.lastInteractionAt) {
    timeline.push({
      date: attio.lastInteractionAt.slice(0, 10),
      type: "interaction",
      summary: "Most recent recorded interaction (Attio aggregate)",
      sources: ["attio"],
    });
  }
  timeline.sort((a, b) => b.date.localeCompare(a.date));

  const regime: ContextBundle["regime"] =
    grain.recordings.length > 0 ||
    !!attio.lastInteractionAt ||
    !!d?.firstMeetingRecording ||
    (!!d?.status && !/^(new|inbound|to review|n\/a)$/i.test(d.status))
      ? "past"
      : "upcoming";

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
  };

  // Gaps — honest about what's still not wired.
  const gaps: Gap[] = [
    {
      description: "Calendar and email are not yet connected",
      resolution: "Coming next — the meeting timeline and email thread (intro + outcome) will fill in",
    },
  ];
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

  const sourcesChecked = [attio.found ? "Attio" : null, "Grain"].filter(Boolean) as string[];

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
    attioNotes: attio.notes,
    gaps,
  };
}
