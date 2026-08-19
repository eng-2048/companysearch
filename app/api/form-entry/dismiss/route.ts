import { NextRequest } from "next/server";
import { addDismissed, removeDismissed } from "@/lib/formDismiss";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Mark a Form Entry meeting as "not needed" (or undo it). Persisted so the row
// stays off the list across sessions.
export async function POST(req: NextRequest) {
  const { key, undo } = await req.json().catch(() => ({}));
  if (!key) return Response.json({ ok: false, error: "key required" }, { status: 400 });
  try {
    if (undo) await removeDismissed(String(key));
    else await addDismissed(String(key));
    return Response.json({ ok: true });
  } catch (e: any) {
    return Response.json({ ok: false, error: e?.message ?? "failed" }, { status: 500 });
  }
}
