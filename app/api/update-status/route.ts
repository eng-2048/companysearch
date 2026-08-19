import { NextRequest } from "next/server";
import { updateStatus, updateFollowUpDate } from "@/lib/attio";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Write a pipeline status change back to the deal_flow entry in Attio. An optional
// followUpDate (YYYY-MM-DD) is written to the Follow Up Date field — used when a
// deal is moved to "Watch" (anywhere in the app), so a check-in date is always set.
export async function POST(req: NextRequest) {
  const { entryId, status, followUpDate } = await req.json().catch(() => ({}));
  if (!entryId || !status) {
    return Response.json({ ok: false, error: "entryId and status are required" }, { status: 400 });
  }
  try {
    await updateStatus(String(entryId), String(status));
    if (followUpDate && /^\d{4}-\d{2}-\d{2}$/.test(String(followUpDate))) {
      await updateFollowUpDate(String(entryId), String(followUpDate));
    }
    return Response.json({ ok: true });
  } catch (e: any) {
    return Response.json({ ok: false, error: e?.message ?? "update failed" }, { status: 500 });
  }
}
