import { NextRequest } from "next/server";
import { updateStatus } from "@/lib/attio";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Write a pipeline status change back to the deal_flow entry in Attio.
export async function POST(req: NextRequest) {
  const { entryId, status } = await req.json().catch(() => ({}));
  if (!entryId || !status) {
    return Response.json({ ok: false, error: "entryId and status are required" }, { status: 400 });
  }
  try {
    await updateStatus(String(entryId), String(status));
    return Response.json({ ok: true });
  } catch (e: any) {
    return Response.json({ ok: false, error: e?.message ?? "update failed" }, { status: 500 });
  }
}
