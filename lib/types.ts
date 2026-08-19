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
  dealFlowEntryId?: string; // to write the pipeline status back
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
  dealFlowEntryId?: string; // present when the status is editable
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
  generatedAt?: string; // ISO timestamp of the scan (from cache or fresh)
  cached?: boolean; // true when served from the day cache
}

// ---- Form Entry (post-meeting deal-feedback drafter) ----
/** How a form field is presented in the drafted card. */
export type FieldControl = "readonly" | "select" | "multiselect" | "longtext";

/** One drafted field of the First Meeting Deal Feedback form. */
export interface FormField {
  label: string;
  value?: string; // drafted value (factual fields; the seeded notes draft)
  blankReason?: string; // why a factual field is blank (flagged, not guessed)
  control?: FieldControl; // interactive control type; defaults to readonly
  options?: string[]; // select/multiselect: the exact Airtable option names
  prefillField?: string; // Airtable field name for the prefill param (defaults to label)
}

/** A recent meeting in the pick-list (lightweight — calendar only, no resolution). */
export interface FormEntryListItem {
  date: string; // YYYY-MM-DD
  time?: string; // HH:MM (24h; formatted client-side)
  title: string;
  person?: string; // the external attendee we met (for the row label)
  company?: string; // company guessed from the email domain (row label)
  term: string; // the title-derived term — used as the draft resolution key
  attendees: { name?: string; email?: string }[];
  key: string; // stable id for the manual "not needed" dismiss store
}

export interface FormEntryList {
  configured: boolean;
  meetings: FormEntryListItem[];
  generatedAt?: string; // ISO timestamp of the scan (from cache or fresh)
  cached?: boolean; // true when served from the day cache
}

/** A drafted form for one meeting (generated on demand when the user clicks Draft). */
export interface FormEntryMeeting {
  date: string;
  time?: string;
  title: string;
  company: string;
  founder?: string;
  attendees: { name?: string; email?: string }[];
  fields: FormField[]; // the drafted form, in section order
  prefillUrl: string; // opens the real Airtable form pre-filled
}

export interface FormDraftResponse {
  resolved: boolean;
  note?: string; // e.g. "Not in the deal pipeline" / "Couldn't match to an Attio record"
  meeting?: FormEntryMeeting; // present when resolved
}

/** A company record offered for disambiguation when several match the query. */
export interface SearchCandidate {
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

/** Streaming protocol between backend and UI. */
export type SearchEvent =
  | { type: "status"; message: string } // progress line, e.g. "Resolving in Attio…"
  | { type: "candidates"; query: string; options: SearchCandidate[] } // pick the right record
  | { type: "bundle"; bundle: ContextBundle } // the finished (or partial) bundle
  | { type: "error"; message: string }
  | { type: "done" };

// ————————————————————————— Pass / Follow-Up module —————————————————————————

/** The pass-email recipient (the CEO). Always shown + editable; `verified` is
 *  false when we couldn't confidently pin the CEO or the email, so the UI flags
 *  it and offers `candidates` to pick from. */
export interface PassRecipient {
  name: string;
  email?: string;
  role?: string;
  verified: boolean;
  candidates: { name: string; email: string; role?: string }[];
}

export interface PassIntroducer {
  name: string;
  email?: string;
  type?: string; // intro_d_by_type
}

export interface PassMeetingRef {
  date: string;
  time?: string;
  title: string;
  term: string;
  attendees: { name?: string; email?: string }[];
}

export interface PassItem {
  section: "toPass" | "recent";
  dealFlowEntryId?: string;
  recordId: string;
  company: string;
  founder?: string;
  status?: string;
  date?: string;
  time?: string;
  description?: string;
  attioUrl?: string;
  recipient: PassRecipient;
  closeLoopEligible: boolean;
  introducer?: PassIntroducer;
  meeting?: PassMeetingRef; // recent-meeting rows carry this so drafting can find Grain
}

export interface PassFollowUpList {
  configured: boolean;
  testMode: boolean;
  testRecipient: string;
  sender?: string;
  toPass: PassItem[];
  toPassTotal?: number; // total in the pipeline when more than we resolve/show
  recent: PassItem[];
  generatedAt?: string;
  cached?: boolean;
}

export interface PassEmailDraft {
  kind: "pass" | "close" | "watch";
  subject: string;
  to: { name?: string; email: string }[];
  cc: { name?: string; email: string }[];
  body: string;
  mode: "fresh" | "reply";
  threadId?: string;
  inReplyTo?: string;
  references?: string;
  grainUrl?: string;
}

/** An email a 2048 address already sent this founder — surfaced so we never
 *  double-send a pass/watch (even one a teammate sent manually). */
export interface PriorOutreach {
  kind: "pass" | "watch" | "outreach";
  who: string;
  date: string;
  subject: string;
}

export interface PassDraftResponse {
  ok: boolean;
  note?: string;
  draft?: PassEmailDraft;
  priorOutreach?: PriorOutreach;
}

export interface PassThreadMessage {
  date: string;
  who: string;
  subject: string;
  snippet: string;
}

export interface PassThreadPreview {
  found: boolean;
  subject?: string; // "Re: …" reply subject
  threadId?: string;
  inReplyTo?: string;
  references?: string;
  messages: PassThreadMessage[];
}

export interface PassSendResponse {
  ok: boolean;
  sent: boolean;
  testMode: boolean;
  actualTo: string[];
  intendedTo: string[];
  intendedCc: string[];
  statusFlipped?: boolean;
  error?: string;
}
