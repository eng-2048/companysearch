import { NextRequest } from "next/server";
import { getMeetingSuggestions } from "@/lib/suggestions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Returns the "your meetings this week" search pre-selects (±7 days by default).
export async function GET(req: NextRequest) {
  const back = Number(req.nextUrl.searchParams.get("back") ?? 7);
  const fwd = Number(req.nextUrl.searchParams.get("forward") ?? 7);
  try {
    const result = await getMeetingSuggestions(back, fwd);
    return Response.json(result);
  } catch (e: any) {
    return Response.json(
      { configured: false, upcoming: [], recent: [], error: e?.message ?? "failed" },
      { status: 200 }
    );
  }
}
