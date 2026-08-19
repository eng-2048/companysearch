import { NextRequest } from "next/server";
import { draftEmail, PassDraftRequest } from "@/lib/passFollowUp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Draft a pass email (to the founder) or a close-the-loop email (to the
// introducer) for one deal. Never sends — returns editable draft text + the
// resolved recipient and thread info. Not cached (depends on reasons / prompt).
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as Partial<PassDraftRequest>;
  const kind = body.kind === "close" ? "close" : body.kind === "watch" ? "watch" : "pass";
  const mode = body.mode === "reply" ? "reply" : "fresh";

  if (!body.recordId && !body.meeting) {
    return Response.json({ ok: false, note: "recordId or meeting is required" }, { status: 400 });
  }

  try {
    const res = await draftEmail({
      kind,
      recordId: body.recordId,
      meeting: body.meeting,
      reasons: Array.isArray(body.reasons) ? body.reasons : [],
      mode,
      customInstructions: typeof body.customInstructions === "string" ? body.customInstructions : undefined,
    });
    return Response.json(res);
  } catch (e: any) {
    return Response.json({ ok: false, note: e?.message ?? "draft failed" }, { status: 500 });
  }
}
