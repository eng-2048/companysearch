import { ContextBundle } from "./types";

// A realistic mock bundle so we can build and verify the whole UI before wiring
// live data. Modeled on the skill's own worked example.
export const MOCK_BUNDLE: ContextBundle = {
  company: "Dynamic Creatures",
  founder: "Marc Theermann",
  generated: "2026-08-14",
  sourcesChecked: ["Attio", "Calendar", "Grain", "Email"],
  regime: "past",
  summary:
    "Dynamic Creatures is building companion robots, founded by Marc Theermann (ex-Boston Dynamics). " +
    "Intro came warm through a mutual connection in June 2026. One first meeting has happened (recorded in Grain). " +
    "They are raising a pre-seed round; deck and CEO LinkedIn are on file. Status: Pursue — next step is a follow-up technical deep-dive.",
  identity: {
    company: "Dynamic Creatures",
    description: "Companion robots for the home",
    domain: "dynamiccreatures.com",
    attioCompanyId: "rec_company_abc123",
    attioPeopleIds: [{ name: "Marc Theermann", id: "rec_person_def456" }],
    pipelineStatus: { value: "Pursue", sources: ["attio"] },
    sourcedBy: "Alex (2048)",
    verticals: ["Robotics", "Consumer Hardware"],
    location: "Boston, MA",
    founded: "2025",
    capitalRaising: "$2.5M pre-seed",
  },
  links: {
    website: { value: "https://dynamiccreatures.com", sources: ["attio"] },
    deck: {
      value: "https://drive.google.com/file/d/mock-deck",
      sources: ["email"],
      note: "Found in post-meeting email, not in Attio",
    },
    dealFolder: {
      value: "https://drive.google.com/drive/folders/mock-folder",
      sources: ["attio"],
    },
    ceoLinkedin: {
      value: "https://linkedin.com/in/marctheermann",
      sources: ["attio"],
    },
    ctoLinkedin: { value: "", sources: ["unknown"], note: "No CTO on file yet" },
    recording: {
      value: "https://grain.com/share/mock-recording",
      sources: ["grain"],
    },
  },
  people: [
    {
      name: "Marc Theermann",
      role: "CEO & Founder",
      emails: ["marc@dynamiccreatures.com", "marc.theermann@gmail.com"],
      background: "Former VP at Boston Dynamics; 10+ years in robotics.",
      sources: ["attio", "grain"],
    },
  ],
  introSource: {
    value: "Warm intro via Jordan Lee (mutual connection)",
    sources: ["email"],
  },
  timeline: [
    {
      date: "2026-06-03",
      type: "email",
      summary: "Warm intro from Jordan Lee connecting Marc to the team",
      sources: ["email"],
    },
    {
      date: "2026-06-10",
      type: "email",
      summary: "Scheduling back-and-forth — first meeting set for June 18",
      sources: ["email"],
    },
    {
      date: "2026-06-18",
      type: "meeting",
      summary: "First meeting — 45 min intro call, recorded in Grain",
      sources: ["cal", "grain"],
    },
    {
      date: "2026-06-19",
      type: "email",
      summary: "Marc sends the deck and a demo video link",
      sources: ["email"],
    },
  ],
  meetings: [
    {
      datetime: "2026-06-18 14:00 EDT",
      title: "2048 <> Dynamic Creatures — Intro",
      attendees: [
        { name: "Marc Theermann", email: "marc@dynamiccreatures.com", rsvp: "accepted" },
        { name: "Alex (2048)", email: "alex@2048.vc", rsvp: "accepted" },
      ],
      recordingUrl: "https://grain.com/share/mock-recording",
      sources: ["cal", "grain"],
    },
  ],
  grainRecordings: [
    {
      title: "Dynamic Creatures Intro Call",
      id: "grain_rec_789",
      url: "https://grain.com/share/mock-recording",
      date: "2026-06-18",
      duration: "45 min",
      summary:
        "Marc walked through the companion-robot vision, the team's Boston Dynamics pedigree, " +
        "and early prototype traction. Discussed pre-seed raise and go-to-market.",
      keyPoints: [
        { speaker: "Marc (founder)", point: "Claims a working prototype with 3 pilot households." },
        { speaker: "Marc (founder)", point: "Raising $2.5M pre-seed, ~$1M soft-committed." },
        { speaker: "Alex (2048)", point: "Asked about unit economics and manufacturing path." },
      ],
    },
  ],
  emailThread: {
    messages: [
      { date: "2026-06-03", from: "Jordan Lee", to: "Alex, Marc", oneLine: "Intro: you two should talk" },
      { date: "2026-06-10", from: "Marc", to: "Alex", oneLine: "Proposing times for a call" },
      { date: "2026-06-19", from: "Marc", to: "Alex", oneLine: "Great to chat — here's the deck + demo" },
    ],
    intro: "Warm intro via Jordan Lee",
    outcome: "Advancing — awaiting follow-up technical deep-dive",
  },
  attioNotes: [],
  gaps: [
    {
      description: "No Attio note for the June 18 meeting",
      resolution: "Meeting intelligence lives in Grain; a note could be added",
    },
    { description: "CTO LinkedIn not on file", resolution: "Ask Marc who leads engineering" },
  ],
};
