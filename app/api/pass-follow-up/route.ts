import { NextRequest } from "next/server";
import { listPassFollowUp } from "@/lib/passFollowUp";
import { PassFollowUpList } from "@/lib/types";
import { readDayCache, writeDayCache } from "@/lib/dayCache";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The Pass / Follow-Up list: To Pass deals + recent meetings. Attio-only and
// day-cached (same pattern as Meeting Prep / Form Entry) — the resolution cost is
// paid once per day; drafting the emails happens on demand per card.
export async function GET(req: NextRequest) {
  const numDays = Number(req.nextUrl.searchParams.get("days") ?? 10);
  const refresh = req.nextUrl.searchParams.get("refresh") === "1";
  const cacheKey = `pass-follow-up-d${numDays}`;

  if (!refresh) {
    const cached = await readDayCache<PassFollowUpList>(cacheKey);
    if (cached) {
      return Response.json({ ...cached.value, generatedAt: cached.generatedAt, cached: true });
    }
  }

  const result = await listPassFollowUp(numDays);
  const generatedAt = new Date().toISOString();
  if (result.configured) await writeDayCache(cacheKey, result, generatedAt);

  return Response.json({ ...result, generatedAt, cached: false });
}
