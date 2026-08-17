import { NextRequest } from "next/server";
import { getDayMeetings } from "@/lib/suggestions";
import { gatherContext } from "@/lib/gather";
import { Links, PrepEntry, PrepLinks } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// A quick primer for the day's meetings: each meeting resolved (Attio-only, fast)
// to its company + the links you want open before the call.

function linkUrl(l?: { value: string; sources: string[] }): string | undefined {
  return l && l.value && l.sources[0] !== "unknown" ? l.value : undefined;
}

export async function GET(req: NextRequest) {
  const date = req.nextUrl.searchParams.get("date") || undefined;
  const { configured, date: day, meetings } = await getDayMeetings(date);

  const entries: PrepEntry[] = await Promise.all(
    meetings.map(async (m): Promise<PrepEntry> => {
      let company = m.term;
      let founder = m.term;
      let status: string | undefined;
      let description: string | undefined;
      let links: PrepLinks = {};
      try {
        const b = await gatherContext(m.term, { attioOnly: true });
        company = b.company;
        founder = b.founder;
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
    })
  );

  return Response.json({ configured, date: day, meetings: entries });
}
