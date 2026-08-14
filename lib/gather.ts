// Maps the Attio resolution into the Context Bundle the UI renders.
// Phase 1: Attio only. Grain / Calendar / Email sections are marked as
// not-yet-connected so the UI is honest about what's wired.

import { AttioResolution, resolveEntity } from "./attio";
import {
  ContextBundle,
  Gap,
  Links,
  Person,
  Sourced,
  TimelineEntry,
} from "./types";

const today = () => new Date().toISOString().slice(0, 10);

function sourced(value: string | undefined, source: Sourced["sources"][number]): Sourced {
  if (value) return { value, sources: [source] };
  return { value: "", sources: ["unknown"] };
}

function buildLinks(r: AttioResolution): Links {
  const d = r.dealFlow;
  const website = r.featuredCompany?.domain
    ? `https://${r.featuredCompany.domain}`
    : undefined;
  return {
    website: sourced(website, "attio"),
    deck: sourced(d?.deckUrl, "attio"),
    dealFolder: sourced(d?.dealFolder, "attio"),
    ceoLinkedin: sourced(d?.ceoLinkedin, "attio"),
    ctoLinkedin: sourced(d?.ctoLinkedin, "attio"),
    recording: sourced(d?.videoLink || d?.firstMeetingRecording, "attio"),
  };
}

function buildPeople(r: AttioResolution): Person[] {
  return r.people.map((p) => ({
    name: p.name,
    role: p.jobTitle,
    emails: p.emails,
    background: undefined,
    sources: ["attio"],
  }));
}

function buildTimeline(r: AttioResolution): TimelineEntry[] {
  const out: TimelineEntry[] = [];
  if (r.lastInteractionAt) {
    out.push({
      date: r.lastInteractionAt.slice(0, 10),
      type: "interaction",
      summary: "Most recent recorded interaction (Attio aggregate)",
      sources: ["attio"],
    });
  }
  return out;
}

function buildSummary(r: AttioResolution): string {
  const c = r.featuredCompany;
  const d = r.dealFlow;
  const parts: string[] = [];
  if (c) {
    parts.push(
      `${c.name}${c.description ? ` — ${c.description}` : ""}${
        c.location ? ` (${c.location})` : ""
      }.`
    );
  }
  const founderNames = r.people.slice(0, 3).map((p) => p.name).join(", ");
  if (founderNames) parts.push(`People on file: ${founderNames}.`);
  if (d?.status) parts.push(`Pipeline status: ${d.status}.`);
  if (d?.introDByName || d?.introDByType) {
    parts.push(
      `Intro: ${[d.introDByName, d.introDByType].filter(Boolean).join(" · ")}.`
    );
  }
  if (d?.capitalRaising) parts.push(`Raising ${d.capitalRaising}.`);
  else if (d?.capitalRaised) parts.push(`Raised ${d.capitalRaised}.`);
  if (d?.nextSteps) parts.push(`Next steps: ${d.nextSteps}.`);
  return parts.join(" ") || "Record found in Attio; limited structured detail on file.";
}

export async function gatherContext(query: string): Promise<ContextBundle> {
  const r = await resolveEntity(query);

  if (!r.found) {
    return {
      company: query,
      founder: query,
      generated: today(),
      sourcesChecked: ["Attio"],
      regime: "upcoming",
      summary: `No Attio record found for "${query}". Try the founder's full name, or the company name/domain.`,
      identity: { company: query },
      links: {},
      people: [],
      timeline: [],
      meetings: [],
      grainRecordings: [],
      attioNotes: [],
      gaps: [
        {
          description: `Nothing matched "${query}" in the companies or people objects`,
          resolution: "Check spelling, or search by founder full name / company domain",
        },
      ],
    };
  }

  const c = r.featuredCompany!;
  const d = r.dealFlow;
  // Without Calendar/Grain yet, infer the regime from Attio signals: any recorded
  // interaction, a first-meeting recording, or a pipeline stage past "New" all
  // imply a meeting has happened.
  const statusPastNew =
    !!d?.status && !/^(new|inbound|to review|n\/a)$/i.test(d.status);
  const hasMeetingSignal =
    !!r.lastInteractionAt || !!d?.firstMeetingRecording || !!d?.videoLink;
  const regime: ContextBundle["regime"] =
    hasMeetingSignal || statusPastNew ? "past" : "upcoming";

  const introSource: Sourced | undefined =
    d?.introDByName || d?.introDByType
      ? {
          value: [d?.introDByName, d?.introDByType].filter(Boolean).join(" · "),
          sources: ["attio"],
        }
      : undefined;

  // Honest gaps: the sources not yet wired in this phase.
  const gaps: Gap[] = [
    {
      description: "Calendar, Grain, and email are not yet connected",
      resolution: "Coming in the next phase — meetings, recordings, and the email thread will fill in",
    },
  ];
  if (!d) {
    gaps.push({
      description: "No deal_flow entry found among candidate records",
      resolution: `Searched ${r.candidatesConsidered} company record(s)`,
    });
  }

  return {
    company: c.name,
    founder: r.founderName || r.people[0]?.name || c.name,
    generated: today(),
    sourcesChecked: ["Attio"],
    regime,
    summary: buildSummary(r),
    identity: {
      company: c.name,
      description: c.description,
      domain: c.domain,
      attioCompanyId: c.recordId,
      attioPeopleIds: r.people.map((p) => ({ name: p.name, id: p.recordId })),
      pipelineStatus: d?.status ? { value: d.status, sources: ["attio"] } : undefined,
      sourcedBy: d?.sourcedBy,
      verticals: d?.verticals ? [d.verticals] : undefined,
      location: c.location,
      founded: c.founded,
      capitalRaised: d?.capitalRaised || c.fundingRaised,
      capitalRaising: d?.capitalRaising,
    },
    links: buildLinks(r),
    people: buildPeople(r),
    introSource,
    timeline: buildTimeline(r),
    meetings: [],
    grainRecordings: [],
    attioNotes: r.notes,
    gaps,
  };
}
