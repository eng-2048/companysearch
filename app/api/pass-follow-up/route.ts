import { NextRequest } from "next/server";
import { listPassFollowUp } from "@/lib/passFollowUp";
import { PassFollowUpList } from "@/lib/types";
import { readDayCache, writeDayCache } from "@/lib/dayCache";
import { readDismissed } from "@/lib/dismissStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Drop deals the user marked "no email needed" (keyed by company record id).
// Applied at serve time — not baked into the day cache — so a dismiss takes effect
// on the next load without a full re-scan.
async function applyDismiss(list: PassFollowUpList): Promise<PassFollowUpList> {
  const dismissed = await readDismissed("pfu-dismissed");
  if (!dismissed.size) return list;
  return {
    ...list,
    toPass: (list.toPass || []).filter((i) => !dismissed.has(i.recordId)),
    recent: (list.recent || []).filter((i) => !dismissed.has(i.recordId)),
  };
}

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
      const filtered = await applyDismiss(cached.value);
      return Response.json({ ...filtered, generatedAt: cached.generatedAt, cached: true });
    }
  }

  const result = await listPassFollowUp(numDays);
  const generatedAt = new Date().toISOString();
  if (result.configured) await writeDayCache(cacheKey, result, generatedAt);

  const filtered = await applyDismiss(result);
  return Response.json({ ...filtered, generatedAt, cached: false });
}
