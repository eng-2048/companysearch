import { NextRequest } from "next/server";
import { getThreadPreview } from "@/lib/passFollowUp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The latest email thread + a short preview for the given recipient(s) — used at
// the review step so the user can see what a "reply in thread" would attach to.
export async function GET(req: NextRequest) {
  const raw = req.nextUrl.searchParams.get("emails") || "";
  const emails = raw.split(",").map((e) => e.trim()).filter(Boolean);
  try {
    const preview = await getThreadPreview(emails);
    return Response.json(preview);
  } catch (e: any) {
    return Response.json({ found: false, messages: [], error: e?.message ?? "thread lookup failed" });
  }
}
