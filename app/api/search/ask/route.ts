import { NextRequest } from "next/server";
import { answerQuestion } from "@/lib/ask";
import { ContextBundle } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Answer a natural-language question about the resolved company, strictly from its
// materials (Grain transcripts, notes, email, facts). The client posts the bundle
// it already has (its grainRecordings ids let us fetch the full transcripts).
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const question = String(body?.question ?? "").trim();
  const bundle = body?.bundle as ContextBundle | undefined;
  if (!question) return Response.json({ ok: false, note: "Ask a question first." }, { status: 400 });
  if (!bundle || !bundle.company) return Response.json({ ok: false, note: "No company context." }, { status: 400 });

  try {
    const result = await answerQuestion(bundle, question);
    return Response.json(result);
  } catch (e: any) {
    return Response.json({ ok: false, note: e?.message ?? "failed" }, { status: 500 });
  }
}
