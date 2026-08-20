import { NextRequest } from "next/server";
import { addDismissed, removeDismissed } from "@/lib/dismissStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const STORE = "pfu-dismissed";

// Mark a Pass/Follow-Up deal as "no email needed" (or undo). Persisted so the card
// stays off the list across sessions. Keyed by the company record id.
export async function POST(req: NextRequest) {
  const { key, undo } = await req.json().catch(() => ({}));
  if (!key) return Response.json({ ok: false, error: "key required" }, { status: 400 });
  try {
    if (undo) await removeDismissed(STORE, String(key));
    else await addDismissed(STORE, String(key));
    return Response.json({ ok: true });
  } catch (e: any) {
    return Response.json({ ok: false, error: e?.message ?? "failed" }, { status: 500 });
  }
}
