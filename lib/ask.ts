// Natural-language Q&A over everything the app knows about a resolved company:
// the FULL Grain call transcript(s), the call summaries, Attio notes, the email
// thread, and the deal facts. Answers strictly from those materials (no outside
// knowledge, no guessing). The raw deck file isn't readable yet (it lives behind
// a Drive/Docsend login) — but the transcript usually covers the deck walkthrough.

import { getTranscript } from "./grain";
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

const SYSTEM = `You answer a VC's (2048 Ventures) questions about one company, using ONLY the provided materials — Grain call transcript(s) and summaries, Attio notes, the email thread, and the deal facts.

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

  const deckUrl = bundle.links?.deck?.value;
  const deckNote = deckUrl
    ? `A pitch deck exists (${deckUrl}) but its file isn't directly readable (hosted behind a login). Its content is usually walked through on the Grain call above.`
    : "No deck on file.";

  const materials = [
    `# Materials for ${bundle.company}`,
    `## Facts\n${facts}`,
    people ? `## People\n${people}` : "",
    grainSummaries ? `## Grain call summaries\n${grainSummaries}` : "",
    notes ? `## Attio notes\n${notes}` : "",
    email ? `## Email thread\n${email}` : "",
    `## Deck\n${deckNote}`,
    `## Full Grain transcript(s)\n${transcripts || "(none available)"}`,
  ]
    .filter(Boolean)
    .join("\n\n");

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
