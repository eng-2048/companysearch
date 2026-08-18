import { NextRequest } from "next/server";
import { draftMeeting, DraftInput } from "@/lib/formEntry";
import { readDayCache, writeDayCache, hashKey } from "@/lib/dayCache";
import { FormDraftResponse } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// A stable per-meeting cache key from its identity (date, time, title, term, attendees).
function draftKey(i: DraftInput): string {
  const emails = i.attendees
    .map((a) => (a.email || "").toLowerCase())
    .filter(Boolean)
    .sort()
    .join(",");
  return `form-entry-draft-${hashKey(`${i.date}|${i.time || ""}|${i.title}|${i.term}|${emails}`)}`;
}

// Draft the First Meeting Deal Feedback form for ONE chosen meeting, on demand.
// Day-cached per meeting so re-drafting (or coming back to it) is instant. Pass
// { refresh: true } to force a fresh resolution. Read-only against Attio/Grain.
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as Partial<DraftInput> & { refresh?: boolean };
  if (!body.date || !body.title || !body.term) {
    return Response.json(
      { resolved: false, note: "date, title and term are required" },
      { status: 400 }
    );
  }

  const input: DraftInput = {
    date: body.date,
    time: body.time,
    title: body.title,
    term: body.term,
    attendees: body.attendees ?? [],
  };
  const key = draftKey(input);

  if (!body.refresh) {
    const cached = await readDayCache<FormDraftResponse>(key);
    if (cached) return Response.json(cached.value);
  }

  try {
    const result = await draftMeeting(input);
    // Cache only a successful resolution — let a failed match retry next time.
    if (result.resolved) await writeDayCache(key, result, new Date().toISOString());
    return Response.json(result);
  } catch (e: any) {
    return Response.json(
      { resolved: false, note: e?.message ?? "draft failed" },
      { status: 500 }
    );
  }
}
