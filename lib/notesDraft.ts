// LLM drafter for the "Other Notes / Analysis" field — writes the post-meeting
// bullets in Zann's voice from the call's Grain summary. This is the app's only
// model call. It degrades gracefully: with no ANTHROPIC_API_KEY (or on any
// error) it returns null and the caller falls back to the raw Grain bullets.
//
// Style spec + few-shot examples are distilled from Zann's own past Deal
// Feedback submissions. Facts only, no invented verdict, no AI-slop.

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
// Cheapest capable model ($1/$5 per 1M) — plenty for a short styling task.
const MODEL = "claude-haiku-4-5";

export const notesDrafterConfigured = (): boolean => !!process.env.ANTHROPIC_API_KEY;

// Real examples of Zann's Other Notes — used to teach the voice, not the content.
const VOICE_EXAMPLES = [
  `- Team seemed awesome - CEO worked in CRE for many years, two co-founders worked together before; all are friends from Cornell
- So much of what he said resonated - best quote - "the only way to build a defensible business in the world of AI is to build a system of record"
- The product looks great - make sure to watch the demo
- I think this is potentially a crowded space, so we'd need to look into competition`,

  `- Founders worked together for 8 years, all in the compliance / employment data space - first at Checkr (background check co), then Middesk
- They bumped into the unemployment insurance space - each paycheck, employers pay into a state and federal unemployment fund. When an employee files, there's payroll and records verification that has to happen (what these guys own) before fed/state pays the claim
- Vision is to own all sides: start with employers / automating state responses, help employees navigate filing, then a government angle for orchestrating payments
- Market seems big - 250K people file unemployment claims each WEEK, over 12M/year in the US
- Incorporated 4 weeks ago so catching very early. MVP is ready and they're starting with 5 design partners`,

  `- This one has some serious hair on it - super old company, they brought in this guy (Employee #2 at Toast) to take over as CTO, and one of the founders of Toast is on the board. They recapped the company
- Basically ConverseNow - same exact concept. Took the call because the CEO looked excellent on paper. Good dude, but only owns 13% of the company
- Traction seems mid too - has some big names in the pipe (large franchisor groups like Arbys, Whataburger) but no real liftoff yet`,

  `- ex-VC from Thomvest - a lot of his work was with the real estate arm of the family office. CTO and head of eng are two guys he's known for a while
- Building an incumbent killer to go after Conservice, which does utility management for property management companies
- If you live in an apartment building there's a ton of friction around utilities - building gets one master bill, splits it across units, handles billing. Instead of doing it in-house they outsource to these companies, which run on a lot of humans and BPO
- Day zero, but has some design partners lined up`,
];

const SYSTEM = `You draft the "Other Notes / Analysis" field of Zann's post-meeting deal-feedback form for 2048 Ventures, in Zann's own voice, from a summary of the call.

Rules — follow exactly:
1. Output ONLY dash-prefixed bullets ("- "), one per line, 3-6 of them. No headers, no preamble, no closing line.
2. Facts from the call only. Do not editorialize or invent labels ("genuine FMF", "epic team", "impressive", "strong founder"). Do not describe or explain any company, person, product, or term the call itself didn't explain (e.g. don't add what a founder's prior employer does if the call didn't say). If the call didn't state it, don't write it.
3. Do NOT add a concern, risk, gap, competitive-landscape, adoption, or "haven't heard about X / would want to look into X / not sure about X" bullet. No speculation, open questions, or things-to-dig-into of any kind — unless the founder or Zann explicitly raised that exact point on the call. When in doubt, leave it out and stop at the facts.
4. Do NOT state a recommendation or lean (pursue / pass / watch / excited / not excited). That verdict is Zann's alone — draft the substance only.
5. Voice: first person, candid, plain, a little colloquial ("kind of", "a bit", "these guys"). Concrete numbers over abstractions. No AI-slop — no "delve/leverage/robust/streamline", no colon-then-reveal, no importance puffery, active voice. NEVER use em dashes (—); use commas, periods, or parentheses instead.
6. Order: lead with who the team is (background, prior companies, how they know each other), then the product in plain English, then traction with numbers, then the round. End on the round or the last real fact — never on a forward-looking or evaluative note.

Below are examples of how Zann writes. Match the VOICE and STRUCTURE, not the content. Note some examples include Zann's own concern or lean — you must not add one yourself; draft only the factual substance.

${VOICE_EXAMPLES.map((e, i) => `Example ${i + 1}:\n${e}`).join("\n\n")}`;

export interface NotesDraftInput {
  company: string;
  founder?: string;
  description?: string;
  callPoints: string[]; // Grain summary points for the meeting
}

const EQUITY_SYSTEM = `You read a VC meeting transcript and pull each founder's equity ownership, ONLY when it is explicitly discussed on the call.

Return one line per founder whose equity is stated, formatted exactly:
Name = <short value>

The value is a brief, faithful descriptor of what was said — e.g. "50%", "~42%, 15% option pool", "equal split", "60/40". If the founders describe an equal split with an option pool but no exact per-person number, write it plainly (e.g. "equal, 15% ESOP"). Use the founder names given, not nicknames.

Hard rules:
- Do NOT put parentheses in the value (it gets wrapped in parens downstream) — use commas.
- Only report what was explicitly said. Never guess or infer a number that wasn't stated.
- If equity / ownership / the cap table is not discussed at all, return the single word NONE.
- Output only the "Name = value" lines (or NONE). No preamble, no other text.`;

/** Pull equity splits per founder from the call transcript. Returns a map of
 *  founder name → short equity string. {} when no key, no transcript, or nothing
 *  was said (never fabricates a number). */
export async function extractEquity(
  transcript: string | undefined,
  founders: string[]
): Promise<Record<string, string>> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key || !transcript || founders.length === 0) return {};
  const user = `Founders: ${founders.join(", ")}\n\nTranscript:\n${transcript}`;
  try {
    const res = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 400,
        system: EQUITY_SYSTEM,
        messages: [{ role: "user", content: user }],
      }),
      cache: "no-store",
    });
    if (!res.ok) return {};
    const j = await res.json();
    if (j.stop_reason === "refusal") return {};
    const text = (j.content || [])
      .filter((b: any) => b.type === "text")
      .map((b: any) => b.text)
      .join("")
      .trim();
    if (/^none$/i.test(text)) return {};
    const map: Record<string, string> = {};
    for (const line of text.split("\n")) {
      const m = line.match(/^\s*-?\s*(.+?)\s*=\s*(.+?)\s*$/);
      if (m && m[1] && m[2]) map[m[1].trim()] = m[2].trim();
    }
    return map;
  } catch {
    return {};
  }
}

const ROUND_SYSTEM = `You read a VC meeting transcript and write the "Round" line for the deal-feedback form, in Zann's terse style, capturing ONLY what was said about financing.

Include, when stated: how much they've already raised (and from whom / on what terms or cap), how much they're raising now (and the round type — pre-seed / seed / etc.), any valuation or cap (e.g. "on $8M post", "at $12M cap"), and how much is committed / circled / available.

Match the format and voice of these real examples:
- Raised $250K, now raising $2M
- Raised $820K from Techstars and Valia, wants to raise $3-5M now
- Raising $2.5M pre-seed
- Raised $2.3M pre-seed (10M post), now raising $3.5M seed at 13.5M post. Has ~$1M available.
- Raising 2.25 on 8.75M post; has 1.5 circled
- Raised $750K uncapped w/ 20% discount, raising $4-5M seed

Rules:
- Only what was explicitly discussed on the call. Never invent numbers, investors, caps, or valuations.
- One short line (two at most). No bullets, no preamble, no other text.
- If financing / the round is not discussed at all, return the single word NONE.`;

/** Pull the round (raised / raising / valuation) from the transcript, in Zann's
 *  format. Returns null when no key, no transcript, or nothing was said. */
export async function extractRound(transcript: string | undefined): Promise<string | null> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key || !transcript) return null;
  try {
    const res = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 300,
        system: ROUND_SYSTEM,
        messages: [{ role: "user", content: `Transcript:\n${transcript}` }],
      }),
      cache: "no-store",
    });
    if (!res.ok) return null;
    const j = await res.json();
    if (j.stop_reason === "refusal") return null;
    const text = (j.content || [])
      .filter((b: any) => b.type === "text")
      .map((b: any) => b.text)
      .join("")
      .trim();
    if (!text || /^none$/i.test(text)) return null;
    return text;
  } catch {
    return null;
  }
}

export async function draftNotes(input: NotesDraftInput): Promise<string | null> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key || input.callPoints.length === 0) return null;

  const user = [
    `Company: ${input.company}`,
    input.founder ? `Founder(s): ${input.founder}` : "",
    input.description ? `One-liner: ${input.description}` : "",
    "",
    "Summary of the call:",
    ...input.callPoints.map((p) => `- ${p}`),
    "",
    "Draft the Other Notes bullets now, in Zann's voice, following every rule.",
  ]
    .filter((l) => l !== "")
    .join("\n");

  try {
    const res = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1024,
        // Haiku 4.5 doesn't think by default and has no effort param — a plain
        // request is correct here (adding either would 400 on this model).
        system: SYSTEM,
        messages: [{ role: "user", content: user }],
      }),
      cache: "no-store",
    });
    if (!res.ok) return null;
    const j = await res.json();
    if (j.stop_reason === "refusal") return null;
    const text = (j.content || [])
      .filter((b: any) => b.type === "text")
      .map((b: any) => b.text)
      .join("")
      .trim();
    // Guard against any stray internal tags; keep only dash-bullet lines.
    const lines = text
      .split("\n")
      .map((l: string) => l.trimEnd())
      .filter((l: string) => l.trim().startsWith("-"));
    return lines.length ? lines.join("\n") : null;
  } catch {
    return null;
  }
}
