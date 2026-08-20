import { NextRequest } from "next/server";
import { getMultiDayMeetings, DayMeeting, companyTermsForEmail } from "@/lib/suggestions";
import { gatherContext } from "@/lib/gather";
import { Links, PrepEntry, PrepLinks, PrepResult } from "@/lib/types";
import { readDayCache, writeDayCache } from "@/lib/dayCache";
import { resolveLink } from "@/lib/attioLinks";
import { normalize } from "@/lib/match";

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

// A generic inbox local part isn't a person's name.
const GENERIC_LOCALS = new Set([
  "info", "team", "hello", "hi", "hey", "contact", "sales", "admin", "support",
  "help", "careers", "press", "invest", "deals", "founders", "founder", "ir", "pr",
]);

/** A person's name from an email local part: anthony@alpa.ca → "Anthony";
 *  john.smith@x.com → "John Smith". Undefined for generic inboxes. */
function nameFromEmailLocal(email?: string): string | undefined {
  const local = email?.split("@")[0]?.toLowerCase();
  if (!local || GENERIC_LOCALS.has(local)) return undefined;
  const parts = local.split(/[._-]+/).filter((p) => p && !/^\d+$/.test(p) && p.length > 1);
  if (!parts.length) return undefined;
  return parts.map((p) => p[0].toUpperCase() + p.slice(1)).join(" ");
}

interface Resolved {
  attioId?: string;
  dealFlowEntryId?: string;
  company: string;
  founder: string;
  status?: string;
  description?: string;
  links: PrepLinks;
}

async function attioResolve(
  term: string,
  emailHints: string[],
  recordId?: string
): Promise<Resolved | null> {
  try {
    const b = await gatherContext(term, { attioOnly: true, emailHints, recordId });
    const L: Links = b.links;
    return {
      attioId: b.identity.attioCompanyId,
      dealFlowEntryId: b.identity.dealFlowEntryId,
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
  // The person we're meeting — prefer a real calendar name, else derive it from
  // their email (anthony@alpa.ca → "Anthony"). Ignore a display name that's just
  // the email address.
  const isRealName = (n?: string) => !!n && !n.includes("@");
  const attendeeName =
    externals.find((a) => isRealName(a.name) && /\s/.test(a.name!))?.name ||
    externals.find((a) => isRealName(a.name))?.name;
  const derivedFirst = nameFromEmailLocal(emailHints[0]);

  // Only a match that actually landed on an Attio record counts.
  let r: Resolved | null = null;

  // 0. A manual "link to Attio" the user set for this meeting overrides everything.
  const linkedId = await resolveLink(m.title, m.attendees);
  if (linkedId) {
    const rr = await attioResolve("", emailHints, linkedId);
    if (rr?.attioId) r = rr;
  }

  // 1. Company-domain emails are the strongest, unambiguous key.
  if (!r)
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
  // The founder shown should be the person in THIS meeting (the attendee), not
  // whatever contact happens to be primary on the Attio record. Use Attio's fuller
  // name only when it's the same person (its first name matches the attendee's).
  let founder = attendeeName;
  if (!founder) {
    const rfFirst = r?.founder ? normalize(r.founder).split(" ")[0] : "";
    const dfFirst = derivedFirst ? normalize(derivedFirst).split(" ")[0] : "";
    if (derivedFirst && rfFirst && rfFirst === dfFirst) founder = r!.founder; // same person, fuller name
    else founder = derivedFirst || r?.founder || company;
  }
  return {
    time: m.time,
    upcoming: m.upcoming,
    title: m.title,
    attendees: m.attendees,
    company,
    founder,
    status: r?.status,
    dealFlowEntryId: r?.dealFlowEntryId,
    attioId: r?.attioId,
    description: r?.description,
    links: r?.links || {},
  };
}

export async function GET(req: NextRequest) {
  const numDays = Number(req.nextUrl.searchParams.get("days") ?? 3);
  const refresh = req.nextUrl.searchParams.get("refresh") === "1";
  const cacheKey = `meeting-prep-d${numDays}`;

  // Serve today's cached scan unless a refresh was asked for.
  if (!refresh) {
    const cached = await readDayCache<PrepResult>(cacheKey);
    if (cached) {
      return Response.json({ ...cached.value, generatedAt: cached.generatedAt, cached: true });
    }
  }

  const { configured, days } = await getMultiDayMeetings(numDays);

  // Resolve every meeting across all days in parallel, then regroup by day.
  const flat = days.flatMap((d) => d.meetings.map((m) => ({ date: d.date, m })));
  const resolved = await Promise.all(
    flat.map(async ({ date, m }) => ({ date, entry: await resolveMeeting(m) }))
  );

  const byDate = new Map<string, PrepEntry[]>(days.map((d) => [d.date, []]));
  for (const { date, entry } of resolved) byDate.get(date)!.push(entry);

  const generatedAt = new Date().toISOString();
  const result: PrepResult = {
    configured,
    days: days.map((d) => ({ date: d.date, meetings: byDate.get(d.date) || [] })),
  };

  // Cache a real scan (don't persist an unconfigured/no-calendar result — retry next time).
  if (configured) await writeDayCache(cacheKey, result, generatedAt);

  return Response.json({ ...result, generatedAt, cached: false });
}
