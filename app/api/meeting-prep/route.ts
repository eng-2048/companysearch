import { NextRequest } from "next/server";
import { getMultiDayMeetings, DayMeeting, companyTermsForEmail } from "@/lib/suggestions";
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
const GENERIC_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "yahoo.com",
  "icloud.com", "me.com", "proton.me", "protonmail.com", "aol.com",
]);
const isCompanyDomain = (email: string): boolean => {
  const dom = email.split("@")[1]?.toLowerCase();
  return !!dom && !GENERIC_DOMAINS.has(dom) && !/\.(edu|ac\.[a-z]{2})$/.test(dom);
};

interface Resolved {
  attioId?: string;
  company: string;
  founder: string;
  status?: string;
  description?: string;
  links: PrepLinks;
}

async function attioResolve(term: string, emailHints: string[]): Promise<Resolved | null> {
  try {
    const b = await gatherContext(term, { attioOnly: true, emailHints });
    const L: Links = b.links;
    return {
      attioId: b.identity.attioCompanyId,
      company: b.company,
      founder: b.founder,
      status: b.identity.pipelineStatus?.value,
      description: b.identity.description,
      links: {
        deck: linkUrl(L.deck),
        ceoLinkedin: linkUrl(L.ceoLinkedin),
        ctoLinkedin: linkUrl(L.ctoLinkedin),
        website: linkUrl(L.website),
        dealFolder: linkUrl(L.dealFolder),
        attioRecord: linkUrl(L.attioRecord),
        recording: linkUrl(L.recording),
      },
    };
  } catch {
    return null;
  }
}

async function resolveMeeting(m: DayMeeting): Promise<PrepEntry> {
  // The external attendees are the reliable key — their email domain is the
  // company; their name is the founder.
  const externals = m.attendees.filter((a) => {
    const dom = (a.email || "").split("@")[1]?.toLowerCase();
    return dom && dom !== INTERNAL_DOMAIN;
  });
  const emailHints = externals.map((a) => a.email!).filter(Boolean);
  // The person we're meeting — prefer a full name, else any attendee name.
  const attendeeName =
    externals.find((a) => a.name && /\s/.test(a.name))?.name ||
    externals.find((a) => a.name)?.name;

  // Only a match that actually landed on an Attio record counts.
  let r: Resolved | null = null;

  // 1. Company-domain emails are the strongest, unambiguous key.
  for (const email of emailHints.filter(isCompanyDomain)) {
    const rr = await attioResolve(email, [email]);
    if (rr?.attioId) {
      r = rr;
      break;
    }
  }

  // 2. Personal/school email (no domain match) → cross-reference the person's
  // OTHER calendar meetings, whose titles often carry the company
  // (owesche@… → "Oliver (Verno)" → Verno). Do this BEFORE trusting the bare
  // title, which is often an ambiguous first name.
  if (!r) {
    for (const email of emailHints) {
      const terms = await companyTermsForEmail(email);
      for (const t of terms.slice(0, 4)) {
        const rr = await attioResolve(t, [email]);
        if (rr?.attioId) {
          r = rr;
          break;
        }
      }
      if (r) break;
    }
  }

  // 3. Last resort: the meeting title itself (linkedin-slug fallback lives here).
  if (!r) {
    const rr = await attioResolve(m.term, emailHints);
    if (rr?.attioId) r = rr;
  }

  const company = r?.company && !r.company.includes("@") ? r.company : m.term;
  return {
    time: m.time,
    upcoming: m.upcoming,
    title: m.title,
    attendees: m.attendees,
    company,
    founder: attendeeName || r?.founder || company,
    status: r?.status,
    description: r?.description,
    links: r?.links || {},
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
