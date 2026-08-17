import { NextRequest } from "next/server";
import { getMultiDayMeetings, DayMeeting } from "@/lib/suggestions";
import { gatherContext } from "@/lib/gather";
import { Links, PrepEntry, PrepLinks } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// A quick primer for the next few days' meetings: each meeting resolved
// (Attio-only, fast) to its company + the links you want open before the call.

function linkUrl(l?: { value: string; sources: string[] }): string | undefined {
  return l && l.value && l.sources[0] !== "unknown" ? l.value : undefined;
}

const INTERNAL_DOMAIN = "2048.vc";

async function resolveMeeting(m: DayMeeting): Promise<PrepEntry> {
  // The external attendees are the reliable key — their email domain is the
  // company. Prefer their name for the founder over anything derived from the
  // (often unreliable) meeting title.
  const externals = m.attendees.filter((a) => {
    const dom = (a.email || "").split("@")[1]?.toLowerCase();
    return dom && dom !== INTERNAL_DOMAIN;
  });
  const emailHints = externals.map((a) => a.email!).filter(Boolean);
  const attendeeName = externals.find((a) => a.name && /\s/.test(a.name))?.name;

  let company = m.term;
  let founder = attendeeName || m.term;
  let status: string | undefined;
  let description: string | undefined;
  let links: PrepLinks = {};
  try {
    const b = await gatherContext(m.term, { attioOnly: true, emailHints });
    company = b.company;
    // Trust the calendar attendee name for the founder; fall back to Attio.
    founder = attendeeName || b.founder;
    status = b.identity.pipelineStatus?.value;
    description = b.identity.description;
    const L: Links = b.links;
    links = {
      deck: linkUrl(L.deck),
      ceoLinkedin: linkUrl(L.ceoLinkedin),
      ctoLinkedin: linkUrl(L.ctoLinkedin),
      website: linkUrl(L.website),
      dealFolder: linkUrl(L.dealFolder),
      attioRecord: linkUrl(L.attioRecord),
      recording: linkUrl(L.recording),
    };
  } catch {
    /* keep the meeting with just its calendar info if resolution fails */
  }
  return {
    time: m.time,
    upcoming: m.upcoming,
    title: m.title,
    attendees: m.attendees,
    company,
    founder,
    status,
    description,
    links,
  };
}

export async function GET(req: NextRequest) {
  const numDays = Number(req.nextUrl.searchParams.get("days") ?? 3);
  const { configured, days } = await getMultiDayMeetings(numDays);

  // Resolve every meeting across all days in parallel, then regroup by day.
  const flat = days.flatMap((d) => d.meetings.map((m) => ({ date: d.date, m })));
  const resolved = await Promise.all(
    flat.map(async ({ date, m }) => ({ date, entry: await resolveMeeting(m) }))
  );

  const byDate = new Map<string, PrepEntry[]>(days.map((d) => [d.date, []]));
  for (const { date, entry } of resolved) byDate.get(date)!.push(entry);

  return Response.json({
    configured,
    days: days.map((d) => ({ date: d.date, meetings: byDate.get(d.date) || [] })),
  });
}
