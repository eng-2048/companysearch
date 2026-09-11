// Natural-language Q&A over everything the app knows about a resolved company:
// the FULL Grain call transcript(s), the call summaries, Attio notes, the email
// thread, and the deal facts. Answers strictly from those materials (no outside
// knowledge, no guessing). The raw deck file isn't readable yet (it lives behind
// a Drive/Docsend login) — but the transcript usually covers the deck walkthrough.

import { getTranscript } from "./grain";
import { deckTextFromUrl } from "./drive";
import { slackContextForCompany } from "./slack";
import { retrieve, isBroadQuestion, Source } from "./retrieve";
import { ContextBundle } from "./types";

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-haiku-4-5";
const MAX_TRANSCRIPT = 140_000; // chars across all recordings (well within context)

export const askConfigured = (): boolean => !!process.env.ANTHROPIC_API_KEY;

export interface AskResult {
  ok: boolean;
  answer?: string;
  used?: string[]; // which materials were available
  note?: string; // error / status when !ok
}

const SYSTEM = `You answer a VC's (2048 Ventures) questions about one company, using ONLY the provided materials — Grain call transcript(s) and summaries, Attio notes, the email thread, the team's Slack channel for the deal, the deck, and the deal facts.

Rules:
- Lead with the answer, then a sentence or two of support. Concise; plain text with short paragraphs or bullets.
- Ground every claim in the materials. Where helpful, say where it came from ("on the call", "in the notes", "per the deal record").
- Use ONLY these materials. No outside knowledge, no guessing, no filler. If the materials don't answer it, say so plainly.
- If a deck exists but wasn't readable and the transcript doesn't cover the point, note the answer may be in the deck.
- No preamble and don't restate the question.`;

export async function answerQuestion(bundle: ContextBundle, question: string): Promise<AskResult> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return { ok: false, note: "The Q&A model isn't configured (ANTHROPIC_API_KEY)." };
  if (!question.trim()) return { ok: false, note: "Ask a question first." };

  const used: string[] = [];

  // Full transcripts — the richest source (often includes the deck walkthrough).
  let transcripts = "";
  try {
    const parts = await Promise.all(
      (bundle.grainRecordings || []).map(async (r) => {
        const t = await getTranscript(r.id);
        return t ? `### Grain call — ${r.title} (${r.date})\n${t}` : "";
      })
    );
    const found = parts.filter(Boolean);
    transcripts = found.join("\n\n");
    if (found.length) used.push(`${found.length} Grain transcript${found.length > 1 ? "s" : ""}`);
  } catch {
    /* transcripts best-effort */
  }
  if (transcripts.length > MAX_TRANSCRIPT) {
    transcripts = transcripts.slice(0, MAX_TRANSCRIPT) + "\n…[transcript truncated]";
  }

  const id = bundle.identity || ({} as ContextBundle["identity"]);
  const facts = [
    `Company: ${bundle.company}`,
    bundle.founder ? `Founder(s): ${bundle.founder}` : "",
    id.description ? `Description: ${id.description}` : "",
    id.verticals?.length ? `Verticals: ${id.verticals.join(", ")}` : "",
    id.location ? `Location: ${id.location}` : "",
    id.founded ? `Founded: ${id.founded}` : "",
    id.pipelineStatus?.value ? `Pipeline status: ${id.pipelineStatus.value}` : "",
    id.capitalRaised ? `Capital raised: ${id.capitalRaised}` : "",
    id.capitalRaising ? `Currently raising: ${id.capitalRaising}` : "",
    bundle.summary ? `Summary: ${bundle.summary}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const people = (bundle.people || [])
    .map((p) => `- ${p.name}${p.role ? ` (${p.role})` : ""}${p.background ? `: ${p.background}` : ""}`)
    .join("\n");
  if (bundle.people?.length) used.push("people");

  const grainSummaries = (bundle.grainRecordings || [])
    .map((r) => {
      const kp = (r.keyPoints || []).map((k) => `  - ${k.speaker ? k.speaker + ": " : ""}${k.point}`).join("\n");
      return `- ${r.title} (${r.date})${r.summary ? `: ${r.summary}` : ""}${kp ? `\n${kp}` : ""}`;
    })
    .join("\n");

  const notes = (bundle.attioNotes || [])
    .map((n) => `- ${n.title}${n.date ? ` (${n.date})` : ""}: ${n.extract}`)
    .join("\n");
  if (bundle.attioNotes?.length) used.push(`${bundle.attioNotes.length} note${bundle.attioNotes.length > 1 ? "s" : ""}`);

  const email = bundle.emailThread
    ? [
        bundle.emailThread.intro ? `Intro: ${bundle.emailThread.intro}` : "",
        bundle.emailThread.outcome ? `Outcome: ${bundle.emailThread.outcome}` : "",
        ...(bundle.emailThread.messages || []).map((m) => `- ${m.date} ${m.from} → ${m.to}: ${m.oneLine}`),
      ]
        .filter(Boolean)
        .join("\n")
    : "";
  if (bundle.emailThread?.messages?.length) used.push("email thread");

  // Read the actual deck from Drive when possible; otherwise note why.
  const deckUrl = bundle.links?.deck?.value;
  const deck = await deckTextFromUrl(deckUrl);
  let deckRaw = ""; // the readable deck body, if any
  let deckNote: string; // shown when the body isn't retrieved (or as a fallback)
  if (deck.accessible && deck.text) {
    deckRaw = deck.text;
    deckNote = `## Deck\nA readable deck is on file${deck.name ? ` (${deck.name})` : ""}; relevant excerpts appear below when they bear on the question.`;
    used.push("deck");
  } else {
    deckNote = deckUrl
      ? `## Deck\nA pitch deck exists (${deckUrl}) but wasn't read: ${deck.note || "not accessible"}. Its content is usually walked through on the Grain call above.`
      : `## Deck\nNo deck on file.`;
  }

  // Slack #deals-<company> channel (verified against the Attio link posted there).
  let slackRaw = "";
  let slackNote = "";
  let slackLabel = "Slack channel";
  try {
    const slack = await slackContextForCompany(bundle.company, id.attioCompanyId);
    if (slack.found && slack.text) {
      slackRaw = slack.text;
      slackLabel = `Slack ${slack.channelName}${slack.verified === "name-only" ? " (name-matched)" : ""}`;
      used.push("Slack channel");
    } else if (slack.found && slack.note) {
      slackNote = `## Slack channel\n${slack.note}`;
    }
  } catch {
    /* Slack is best-effort */
  }

  // The compact sources are always sent in full — they're small and high-signal.
  const compact = [
    `# Materials for ${bundle.company}`,
    `## Facts\n${facts}`,
    people ? `## People\n${people}` : "",
    grainSummaries ? `## Grain call summaries\n${grainSummaries}` : "",
    notes ? `## Attio notes\n${notes}` : "",
    email ? `## Email thread\n${email}` : "",
    slackNote,
    deckNote,
  ].filter(Boolean);

  // The heavy sources (transcript, deck body, Slack history) are large. For a
  // specific question we send only the chunks that hit the query terms — much
  // cheaper. Broad questions ("summarize", "walk me through") get the full text.
  const heavy: Source[] = [
    transcripts ? { label: "Grain transcript(s)", text: transcripts } : null,
    deckRaw ? { label: "Deck", text: deckRaw } : null,
    slackRaw ? { label: slackLabel, text: slackRaw } : null,
  ].filter(Boolean) as Source[];

  let heavySection: string;
  if (isBroadQuestion(question) || !heavy.length) {
    heavySection = heavy
      .map((s) => `## ${s.label} (full)\n${s.text}`)
      .join("\n\n");
  } else {
    const r = retrieve(heavy, question);
    heavySection = r.hits
      ? r.text
      : // Nothing matched the query terms — fall back to full so we never miss.
        heavy.map((s) => `## ${s.label} (full)\n${s.text}`).join("\n\n");
  }

  const materials = [...compact, heavySection].filter(Boolean).join("\n\n");

  const user = `${materials}\n\n---\nQuestion: ${question}\n\nAnswer using only the materials above.`;

  try {
    const res = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: MODEL, max_tokens: 1500, system: SYSTEM, messages: [{ role: "user", content: user }] }),
      cache: "no-store",
    });
    if (!res.ok) return { ok: false, note: `Model error (HTTP ${res.status}).` };
    const j = await res.json();
    if (j.stop_reason === "refusal") return { ok: false, note: "The model declined to answer." };
    const answer = (j.content || [])
      .filter((b: any) => b.type === "text")
      .map((b: any) => b.text)
      .join("")
      .trim();
    if (!answer) return { ok: false, note: "No answer returned." };
    return { ok: true, answer, used };
  } catch {
    return { ok: false, note: "Q&A request failed." };
  }
}
