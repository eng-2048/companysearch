// Context Bundle — the exact data structure the company-search skill produces.
// Every fact carries a source tag so the UI (and downstream skills) know provenance.

export type SourceTag = "attio" | "cal" | "grain" | "email" | "unknown";

export type Regime = "past" | "upcoming";

/** A value plus where it came from. Used for anything that needs provenance. */
export interface Sourced<T = string> {
  value: T;
  sources: SourceTag[];
  /** Optional note, e.g. what would resolve an [unknown]. */
  note?: string;
}

export interface Identity {
  company: string;
  description?: string;
  domain?: string; // real domain, or undefined for none/dummy
  attioCompanyId?: string;
  attioPeopleIds?: { name: string; id: string }[];
  pipelineStatus?: Sourced; // deal_flow status: New / Pursue / Termsheet / Pass...
  sourcedBy?: string;
  verticals?: string[];
  location?: string;
  founded?: string;
  capitalRaised?: string;
  capitalRaising?: string;
}

export interface Links {
  website?: Sourced;
  deck?: Sourced;
  dealFolder?: Sourced;
  ceoLinkedin?: Sourced;
  ctoLinkedin?: Sourced;
  recording?: Sourced; // video_link / demo / Loom / YouTube / Grain
  attioRecord?: Sourced; // the company record in Attio
}

export interface Person {
  name: string;
  role?: string;
  emails: string[];
  background?: string;
  sources: SourceTag[];
}

export interface TimelineEntry {
  date: string; // ISO or human
  type: string; // "email", "meeting", "note", etc.
  summary: string;
  sources: SourceTag[];
}

export interface Meeting {
  datetime: string; // with timezone
  title: string;
  attendees: {
    name?: string;
    email?: string;
    optional?: boolean;
    rsvp?: string;
  }[];
  recordingUrl?: string; // Grain link, or undefined = "none"
  notesUrl?: string; // Attio note for this meeting (matched by date), or undefined
  upcoming?: boolean; // start is in the future (time-based, not just date)
  startISO?: string; // raw start timestamp, for chronological sorting
  sources: SourceTag[];
}

export interface GrainRecording {
  title: string;
  id: string;
  url: string;
  date: string;
  duration?: string;
  summary?: string;
  keyPoints?: { speaker?: string; point: string }[]; // attributed
}

export interface EmailThread {
  messages: {
    date: string;
    from: string;
    to: string;
    oneLine: string;
  }[];
  intro?: string; // who made it / outbound
  outcome?: string; // disposition + operative phrase
}

export interface AttioNote {
  title: string;
  date?: string;
  extract: string;
}

export interface Gap {
  description: string; // what was searched for and not found
  resolution?: string; // what would resolve it
}

export interface ContextBundle {
  company: string;
  founder: string;
  generated: string; // date
  sourcesChecked: string[]; // ["Attio","Calendar","Grain","Email"]
  regime: Regime;
  meetingDate?: string; // for upcoming regime
  summary: string; // 3-5 lines, factual, no judgment

  identity: Identity;
  links: Links;
  people: Person[];
  introSource?: Sourced;
  timeline: TimelineEntry[];
  meetings: Meeting[];
  grainRecordings: GrainRecording[];
  emailThread?: EmailThread;
  attioNotes: AttioNote[];
  gaps: Gap[];
}

// ---- Meeting prep (today's meetings primer) ----
export interface PrepLinks {
  deck?: string;
  ceoLinkedin?: string;
  ctoLinkedin?: string;
  website?: string;
  dealFolder?: string;
  attioRecord?: string;
  recording?: string;
}

export interface PrepEntry {
  time?: string; // HH:MM (24h; formatted client-side)
  upcoming: boolean;
  title: string;
  attendees: { name?: string; email?: string; rsvp?: string }[];
  company: string;
  founder: string;
  status?: string;
  description?: string;
  links: PrepLinks;
}

export interface PrepDay {
  date: string;
  meetings: PrepEntry[];
}

export interface PrepResult {
  configured: boolean;
  days: PrepDay[];
}

/** Streaming protocol between backend and UI. */
export type SearchEvent =
  | { type: "status"; message: string } // progress line, e.g. "Resolving in Attio…"
  | { type: "bundle"; bundle: ContextBundle } // the finished (or partial) bundle
  | { type: "error"; message: string }
  | { type: "done" };
