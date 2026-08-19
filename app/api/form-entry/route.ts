import { NextRequest } from "next/server";
import { listRecentMeetings } from "@/lib/formEntry";
import { readDayCache, writeDayCache } from "@/lib/dayCache";
import { readDismissed } from "@/lib/formDismiss";
import { submittedCompanyKeys } from "@/lib/airtable";
import { squish } from "@/lib/match";
import { FormEntryList } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Drop meetings the user marked "not needed", and (when Airtable is connected)
// meetings whose Deal Feedback form was already submitted. Applied at serve time —
// not baked into the day cache — so a dismiss or a fresh submission takes effect on
// the next load without a full re-scan.
async function applyTodoFilters(list: FormEntryList): Promise<FormEntryList> {
  if (!list.configured || !list.meetings?.length) return list;
  const [dismissed, submitted] = await Promise.all([readDismissed(), submittedCompanyKeys()]);
  const meetings = list.meetings.filter(
    (m) => !dismissed.has(m.key) && !(m.company && submitted.has(squish(m.company)))
  );
  return { ...list, meetings };
}

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
      const filtered = await applyTodoFilters(cached.value);
      return Response.json({ ...filtered, generatedAt: cached.generatedAt, cached: true });
    }
  }

  try {
    const result = await listRecentMeetings(numDays);
    const generatedAt = new Date().toISOString();
    // Cache the full resolved scan; filter (dismiss / submitted) at serve time.
    if (result.configured) await writeDayCache(cacheKey, result, generatedAt);
    const filtered = await applyTodoFilters(result);
    return Response.json({ ...filtered, generatedAt, cached: false });
  } catch (e: any) {
    return Response.json(
      { configured: false, meetings: [], error: e?.message ?? "failed" },
      { status: 500 }
    );
  }
}
