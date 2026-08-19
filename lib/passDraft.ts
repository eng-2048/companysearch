// LLM drafter for the Pass / Follow-Up module — writes the pass email to a
// founder and the "close the loop" email to whoever introduced the deal, in
// Zann's voice, lightly tailored from the Grain call. Cheapest model. Degrades
// gracefully: with no ANTHROPIC_API_KEY (or on any error) it fills the base
// template deterministically so the user always gets an editable draft.

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-haiku-4-5";

export const passDrafterConfigured = (): boolean => !!process.env.ANTHROPIC_API_KEY;

// Zann's real templates — the voice + structure the model must match.
const GENERIC_PASS = `Hey {first_name},

Thanks again for your time, and for considering 2048 Ventures as a potential partner in your journey. I had a chance to sync up with my team, and while there were elements of your business we really liked, we ultimately decided this won't be a fit for us.

As a small & lean fund, we can only work on a few opportunities at a time, and are often forced to choose between very compelling ones. At the pre-seed, we recognize it's a highly subjective decision, so we could be wrong (and often are). We hope you understand our perspective, and regardless, look forward to staying in touch.

Thank you again, and I'm wishing you all the best.

Warmly,
Zann`;

// A longer, dug-in pass — shows how specific sticking points are woven in.
const DETAILED_PASS_EXAMPLE = `Hey Matt,

I wanted to follow up with you. We appreciate you sharing the business with 2048 Ventures and enjoyed getting to know you.

As we had more time to think about it and review the materials, we decided that this opportunity won't be a fit for 2048 Ventures.

First of all, and this almost goes without saying, we think you are an incredible founder and have built a very compelling team around you. Above all, this is what made our decision so difficult.

Unfortunately, however, there were a few sticking points on our end. While we do think the concept of live classes is novel, we are not sure this is the widget both consumers and trainers prefer, and after talking to a few trainers it became clear they value predictability. We also would have liked to see a more fleshed out business-in-a-box for trainers, especially SaaS tooling to help them manage their business.

Obviously we could be totally wrong on any (or all) of the above, but we wanted to be transparent in our thought process and decision making.

Thank you again for the opportunity and wishing you the best of luck.

All my best,
Zann`;

const CLOSE_LOOP_LONG = `Hi {source_first},

Thank you so much for sending {founder} and {company} our way. We enjoyed getting to know the team, and the business.

As we had more time to think about it, and review the materials, we decided that this opportunity won't be a fit for 2048 Ventures.

Thank you again for sharing this opportunity with us, and please keep sending us exceptional early stage founders.

Zann`;

const CLOSE_LOOP_SHORT = `{source_first} — thank you for the intro to {founder}. We had a chance to dig in with them but ultimately didn't get there on an investment. Thank you for sending and please always send us exceptional people in your network. We really appreciate it.

Best,
Zann`;

// "Keep in touch" — explicitly NOT a pass. An open door, forward-looking.
const WATCH_KEEP_IN_TOUCH = `Hey {first_name},

Thanks again for taking the time to meet, and for sharing {company} with us. I really enjoyed the conversation and learning about what you're building.

We're not in a position to move forward right now, but I'd genuinely love to stay close as you continue to build. Please keep me posted on your progress and any big milestones, and don't hesitate to reach out if there's anything I can help with along the way.

Looking forward to staying in touch.

Warmly,
Zann`;

// How each pass reason should steer the sticking-point language.
const REASON_GUIDE: Record<string, string> = {
  "Market size": "the market feeling too small / early / niche for a venture-scale outcome",
  "Competitive landscape": "the space feeling crowded or the differentiation vs. incumbents/competitors not yet clear",
  "Round dynamics": "round dynamics — timing, valuation, round size, or how competitive the round is",
  Generic: "a general, non-specific fit decision without calling out one hard reason",
};

function fillGenericPass(firstName: string): string {
  return GENERIC_PASS.replace("{first_name}", firstName || "there");
}
function fillWatch(firstName: string, company: string): string {
  return WATCH_KEEP_IN_TOUCH.replace("{first_name}", firstName || "there").replace("{company}", company || "your company");
}
function fillCloseLoop(sourceFirst: string, founder: string, company: string, short = false): string {
  const t = short ? CLOSE_LOOP_SHORT : CLOSE_LOOP_LONG;
  return t
    .replace(/{source_first}/g, sourceFirst || "there")
    .replace(/{founder}/g, founder || "the team")
    .replace(/{company}/g, company || "the company");
}

const PASS_SYSTEM = `You draft a pass email from Zann (2048 Ventures, a pre-seed fund) to a founder his firm has decided not to invest in. It is warm, humble, and human — never harsh, never a form letter.

Structure to follow:
1. "Hey {first name}," on its own line.
2. Thank them for their time / for sharing the business; a genuine warm note about the team or founder when the call warrants it.
3. State plainly that after discussing internally, 2048 decided this won't be a fit right now.
4. If (and only if) specific reasons or real call details are provided, add ONE short paragraph with one to three honest, specific sticking points grounded in THIS company and what was actually discussed. Tie them to the selected reason(s). Never invent facts the call didn't contain.
5. Keep Zann's humility: small/lean fund, forced to choose between compelling opportunities, pre-seed is highly subjective, "we could be wrong (and often are)".
6. Warm close and sign off exactly:
Warmly,
Zann

Hard rules:
- Match the voice of the templates below: candid, plain, generous, first person. No corporate filler.
- NEVER use em dashes (—). Use commas, periods, or parentheses.
- No AI-slop (no "delve/leverage/robust/streamline", no importance puffery, no colon-then-reveal).
- Do not fabricate specifics. If no real sticking points are available, stay close to the generic template and do not manufacture a hard reason.
- Output ONLY the email body (greeting through "Zann"). No subject line, no preamble, no commentary.

Base template (use this voice; expand only when there is real substance):
${GENERIC_PASS}

Example of a longer, dug-in pass with specific sticking points woven in:
${DETAILED_PASS_EXAMPLE}`;

const CLOSE_SYSTEM = `You draft a short "close the loop" email from Zann (2048 Ventures) to the person who INTRODUCED a deal, letting them know 2048 passed. It is warm and appreciative, and encourages more intros.

Structure:
1. "Hi {source first name}," (or "{source first name} —" for a very short note).
2. Thank them for the intro to {founder} / {company}.
3. Say that after digging in, 2048 decided it won't be a fit / didn't get there on an investment.
4. Optionally one short clause on why, ONLY if real reasons are provided and it makes sense to share with an introducer (keep it light and non-disparaging).
5. Thank them again and ask them to keep sending exceptional founders. Sign off "Zann" or "Best,\\nZann".

Hard rules:
- Warm, brief (a short paragraph or two). Never disparage the founder to the introducer.
- NEVER use em dashes (—) except the stylistic "{Name} —" opener. No AI-slop.
- Output ONLY the email body. No subject line, no preamble.

Templates to match:
${CLOSE_LOOP_LONG}

Shorter variant:
${CLOSE_LOOP_SHORT}`;

const WATCH_SYSTEM = `You draft a warm "keep in touch" email from Zann (2048 Ventures, a pre-seed fund) to a founder 2048 met but is NOT investing in right now.

CRUCIAL: this is NOT a pass or rejection. Never say it "won't be a fit", that 2048 "decided not to invest", or anything that reads as a no. It is an OPEN DOOR — 2048 isn't moving right now (framed as timing), but genuinely wants to stay close and follow the journey.

Structure:
1. "Hey {first name}," on its own line.
2. Thank them for their time / for sharing the company; a genuine, specific note about the conversation or team.
3. Say 2048 isn't in a position to move forward right now (timing), and that you'd love to stay close and keep in touch as they build.
4. Invite them to keep you posted on progress and milestones, and to reach out if you can help in the meantime.
5. Warm close, sign off exactly:
Warmly,
Zann

Hard rules:
- Never phrase this as a pass, rejection, or "not a fit".
- NEVER use em dashes (—). No AI-slop. Zann's warm, plain, first-person voice.
- Output ONLY the email body (greeting through "Zann"). No subject, no preamble.

Template to match:
${WATCH_KEEP_IN_TOUCH}`;

async function callModel(system: string, user: string, maxTokens: number): Promise<string | null> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
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
        max_tokens: maxTokens,
        system,
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
    return text || null;
  } catch {
    return null;
  }
}

export interface PassDraftInput {
  company: string;
  founderFirstName: string;
  founderFullName?: string;
  reasons: string[];
  callPoints?: string[];
  transcript?: string;
  customInstructions?: string;
}

/** Draft the founder pass email. Always returns a body (LLM, or the filled
 *  template as a fallback). */
export async function draftPassEmail(input: PassDraftInput): Promise<string> {
  const fallback = fillGenericPass(input.founderFirstName);
  const key = process.env.ANTHROPIC_API_KEY;

  // The pre-loaded default is the plain generic template. Only tailor with the
  // call (specific sticking points) once Zann picks a real reason or gives
  // instructions — so the initial draft is never invented and loads instantly.
  const hasSubstance =
    input.reasons.some((r) => r !== "Generic") || !!input.customInstructions?.trim();
  if (!key || !hasSubstance) return fallback;

  const reasonLines = input.reasons
    .map((r) => `- ${r}: ${REASON_GUIDE[r] || r}`)
    .join("\n");

  const user = [
    `Company: ${input.company}`,
    input.founderFirstName
      ? `Founder first name: ${input.founderFirstName}`
      : `Founder first name: (unknown — greet neutrally, e.g. "Hi there,")`,
    input.founderFullName ? `Founder: ${input.founderFullName}` : "",
    input.reasons.length ? `Reason(s) for passing (steer the sticking points):\n${reasonLines}` : "",
    input.customInstructions ? `Extra instructions from Zann (follow these):\n${input.customInstructions}` : "",
    input.callPoints && input.callPoints.length
      ? `Call summary points (use for specifics, do not copy verbatim):\n${input.callPoints.map((p) => `- ${p}`).join("\n")}`
      : "",
    input.transcript ? `Call transcript (for grounding specifics only):\n${input.transcript.slice(0, 12000)}` : "",
    "",
    "Draft the pass email now. Weave in one to three specific, honest sticking points grounded in the call and tied to the reason(s) and instructions, in Zann's humble, warm voice.",
  ]
    .filter((l) => l !== "")
    .join("\n");

  const out = await callModel(PASS_SYSTEM, user, 1200);
  return out || fallback;
}

export interface WatchDraftInput {
  company: string;
  founderFirstName: string;
  founderFullName?: string;
  callPoints?: string[];
  transcript?: string;
  customInstructions?: string;
}

/** Draft the "keep in touch" (watch) email — never a pass. Generic template by
 *  default; tailored only when Zann adds custom instructions. */
export async function draftWatchEmail(input: WatchDraftInput): Promise<string> {
  const fallback = fillWatch(input.founderFirstName, input.company);
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key || !input.customInstructions?.trim()) return fallback;

  const user = [
    `Company: ${input.company}`,
    input.founderFirstName
      ? `Founder first name: ${input.founderFirstName}`
      : `Founder first name: (unknown — greet neutrally, e.g. "Hi there,")`,
    input.founderFullName ? `Founder: ${input.founderFullName}` : "",
    `Extra instructions from Zann (follow these):\n${input.customInstructions}`,
    input.callPoints && input.callPoints.length
      ? `Call summary points (context, do not copy verbatim):\n${input.callPoints.map((p) => `- ${p}`).join("\n")}`
      : "",
    "",
    "Draft the keep-in-touch email now. Remember: this is NOT a pass — keep the door open and warm.",
  ]
    .filter((l) => l !== "")
    .join("\n");

  const out = await callModel(WATCH_SYSTEM, user, 900);
  return out || fallback;
}

export interface CloseLoopInput {
  company: string;
  founderName: string;
  sourceFirstName: string;
  reasons: string[];
  callPoints?: string[];
  customInstructions?: string;
}

/** Draft the close-the-loop email to the introducer. Always returns a body. */
export async function draftCloseLoop(input: CloseLoopInput): Promise<string> {
  const fallback = fillCloseLoop(input.sourceFirstName, input.founderName, input.company);
  const key = process.env.ANTHROPIC_API_KEY;
  // Generic close-the-loop template by default; tailor only on reasons/instructions.
  const hasSubstance =
    input.reasons.some((r) => r !== "Generic") || !!input.customInstructions?.trim();
  if (!key || !hasSubstance) return fallback;

  const user = [
    `Company: ${input.company}`,
    `Founder: ${input.founderName}`,
    `Introducer first name: ${input.sourceFirstName}`,
    input.reasons.length ? `Reason(s) 2048 passed (share only if tasteful): ${input.reasons.join(", ")}` : "",
    input.customInstructions ? `Extra instructions from Zann (follow these):\n${input.customInstructions}` : "",
    input.callPoints && input.callPoints.length
      ? `Call summary points (context):\n${input.callPoints.map((p) => `- ${p}`).join("\n")}`
      : "",
    "",
    "Draft the close-the-loop email now, warm and brief.",
  ]
    .filter((l) => l !== "")
    .join("\n");

  const out = await callModel(CLOSE_SYSTEM, user, 700);
  return out || fallback;
}
