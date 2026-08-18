import { NextRequest } from "next/server";
import { listRecentMeetings } from "@/lib/formEntry";
import { readDayCache, writeDayCache } from "@/lib/dayCache";
import { FormEntryList } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The pick-list of recent meetings. Lightweight (calendar only), day-cached so
// re-opening / navigating back is instant; `?refresh=1` re-scans. The expensive
// Attio + Grain resolution still happens per meeting via POST /api/form-entry/draft.
export async function GET(req: NextRequest) {
  const numDays = Number(req.nextUrl.searchParams.get("days") ?? 3);
  const refresh = req.nextUrl.searchParams.get("refresh") === "1";
  const cacheKey = `form-entry-list-d${numDays}`;

  if (!refresh) {
    const cached = await readDayCache<FormEntryList>(cacheKey);
    if (cached) {
      return Response.json({ ...cached.value, generatedAt: cached.generatedAt, cached: true });
    }
  }

  try {
    const result = await listRecentMeetings(numDays);
    const generatedAt = new Date().toISOString();
    if (result.configured) await writeDayCache(cacheKey, result, generatedAt);
    return Response.json({ ...result, generatedAt, cached: false });
  } catch (e: any) {
    return Response.json(
      { configured: false, meetings: [], error: e?.message ?? "failed" },
      { status: 500 }
    );
  }
}
