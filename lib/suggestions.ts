// Meeting-derived search pre-selects: "your meetings this week" → clickable
// entries that launch a company-search. Built from the user's own calendar
// (primary), filtered to external deal meetings, with the company/founder
// inferred from the meeting title (2048's titling conventions).

import {
  listPrimaryWindow,
  calendarConfigured,
  internalNameTokens,
  resolveCalendar,
  GCalEvent,
} from "./gcal";
import { normalize } from "./match";

const INTERNAL_DOMAIN = "2048.vc";

export interface MeetingSuggestion {
  term: string; // what to search for
  title: string; // the meeting title (shown as context)
  date: string; // YYYY-MM-DD
  time?: string; // HH:MM (omitted for all-day)
  upcoming: boolean;
}

export interface SuggestionsResult {
  configured: boolean;
  upcoming: MeetingSuggestion[];
  recent: MeetingSuggestion[];
}

// Split a title into parts: 2048's separators plus attendee-list joiners.
const SPLIT = /\s*(?:\/\/|<>|\||\/|—|–|\s-\s|:|\s&\s|\band\b|\bwith\b|\bvs\b)\s*/gi;

// Generic non-deal meeting words — if a segment reduces to one of these, drop it.
const STOP = new Set([
  "coffee chat", "coffee", "catch up", "catchup", "placeholder", "sync", "intro",
  "check in", "checkin", "weekly", "biweekly", "monthly", "standup", "lunch",
  "dinner", "office hours", "walk", "call", "meeting", "chat", "team", "internal",
  "re", "coding", "block", "hold", "tbd", "prep", "1 1", "quick", "connect",
]);

const isStop = (norm: string) => norm.length < 2 || STOP.has(norm);

/** Infer the company/founder to search from a meeting title. */
function deriveTerm(title: string, internalNameTokens: Set<string>): string | undefined {
  const segments = title.split(SPLIT).map((s) => s.trim()).filter(Boolean);
  const candidates: string[] = [];
  for (let seg of segments) {
    if (/2048/.test(seg.toLowerCase())) continue; // drop the "2048 Ventures" / "2048vc" side
    // "Name (Company)" → prefer the parenthetical when it looks like a company.
    const paren = seg.match(/^(.+?)\s*\(([^)]+)\)\s*$/);
    if (paren) {
      const inside = paren[2].trim();
      if (!/^(2048|stealth|ceo|cto|co-?founder|founder|intro)/i.test(inside)) {
        if (!isStop(normalize(inside))) candidates.push(inside);
        continue;
      }
      seg = paren[1].trim();
    }
    // Strip internal partner name tokens from within the segment ("Zann Ali and
    // Ken Lau" → "Ken Lau"), then keep what's left if it's a real name/company.
    const cleaned = seg
      .split(/\s+/)
      .filter((w) => {
        const wn = normalize(w);
        return wn && !internalNameTokens.has(wn);
      })
      .join(" ")
      .trim();
    if (cleaned && !isStop(normalize(cleaned))) candidates.push(cleaned);
  }
  if (!candidates.length) return undefined;
  candidates.sort((a, b) => b.length - a.length); // the company name is usually the longest part
  return candidates[0];
}

export interface DayMeeting {
  term: string;
  title: string;
  startISO: string;
  time?: string;
  upcoming: boolean;
  attendees: { name?: string; email?: string; rsvp?: string }[];
}

/** Turn a calendar event into an external deal meeting, or null if it isn't one. */
function eventToDayMeeting(ev: GCalEvent, teamTokens: string[]): DayMeeting | null {
  if (/^grain data for/i.test(ev.title)) return null;
  if (/\[\s*hold\s*\]/i.test(ev.title)) return null; // calendar hold, not a meeting
  const attendees = ev.attendees || [];
  if (attendees.length === 0 || attendees.length > 12) return null;

  const internalTokens = new Set<string>(teamTokens);
  let hasExternal = false;
  for (const a of attendees) {
    const dom = (a.email || "").split("@")[1]?.toLowerCase();
    if (!dom) continue;
    if (dom === INTERNAL_DOMAIN) {
      if (a.name) for (const t of normalize(a.name).split(" ")) if (t.length > 2) internalTokens.add(t);
    } else {
      hasExternal = true;
    }
  }
  if (!hasExternal) return null;

  const term = deriveTerm(ev.title, internalTokens);
  if (!term) return null;

  return {
    term,
    title: ev.title,
    startISO: ev.startISO,
    time: ev.allDay ? undefined : ev.startISO.slice(11, 16),
    upcoming: ev.upcoming,
    attendees: attendees.map((a) => ({ name: a.name, email: a.email, rsvp: a.responseStatus })),
  };
}

/** Local YYYY-MM-DD, `offset` days from today. */
function localDate(offset: number): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** External deal meetings for the next `numDays` days (today first), grouped by date. */
/**
 * Company/founder search terms inferred from ALL of a person's calendar meetings.
 * Lets us recover the company when one meeting's title is unhelpful (just a first
 * name) by borrowing a richer title from another meeting with the same person —
 * e.g. owesche@… also has "Zann // Oliver (Verno)" -> "Verno".
 */
export async function companyTermsForEmail(email: string): Promise<string[]> {
  if (!calendarConfigured() || !email) return [];
  const [{ events }, teamTokens] = await Promise.all([
    resolveCalendar([], [email]),
    internalNameTokens(),
  ]);
  const terms: string[] = [];
  const seen = new Set<string>();
  for (const ev of events) {
    const dm = eventToDayMeeting(ev, teamTokens);
    if (!dm) continue;
    const key = normalize(dm.term);
    if (key && !seen.has(key)) {
      seen.add(key);
      terms.push(dm.term);
    }
  }
  return terms;
}

export async function getMultiDayMeetings(
  numDays = 3
): Promise<{ configured: boolean; days: { date: string; meetings: DayMeeting[] }[] }> {
  if (!calendarConfigured()) return { configured: false, days: [] };

  const [events, teamTokens] = await Promise.all([
    listPrimaryWindow(1, numDays),
    internalNameTokens(),
  ]);

  const dates = Array.from({ length: numDays }, (_, i) => localDate(i));
  const byDate = new Map<string, DayMeeting[]>(dates.map((d) => [d, []]));
  for (const ev of events) {
    const bucket = byDate.get(ev.startISO.slice(0, 10));
    if (!bucket) continue;
    const dm = eventToDayMeeting(ev, teamTokens);
    if (dm) bucket.push(dm);
  }

  const days = dates.map((date) => ({
    date,
    meetings: (byDate.get(date) || []).sort((a, b) => a.startISO.localeCompare(b.startISO)),
  }));
  return { configured: true, days };
}

/**
 * External deal meetings that have ALREADY HAPPENED in the last `numDays` days
 * (today included), most-recent first. The basis for post-meeting Form Entry.
 */
export async function getPastDaysMeetings(
  numDays = 3
): Promise<{ configured: boolean; meetings: { date: string; m: DayMeeting }[] }> {
  if (!calendarConfigured()) return { configured: false, meetings: [] };

  const [events, teamTokens] = await Promise.all([
    // look back numDays, +1 forward so we capture all of today's window
    listPrimaryWindow(numDays, 1),
    internalNameTokens(),
  ]);

  // today, yesterday, day-before … (numDays calendar days back through today)
  const dateSet = new Set(Array.from({ length: numDays }, (_, i) => localDate(-i)));

  const out: { date: string; m: DayMeeting }[] = [];
  for (const ev of events) {
    const day = ev.startISO.slice(0, 10);
    if (!dateSet.has(day)) continue;
    const dm = eventToDayMeeting(ev, teamTokens);
    if (!dm) continue;
    if (dm.upcoming) continue; // only meetings that already occurred
    out.push({ date: day, m: dm });
  }
  out.sort((a, b) => b.m.startISO.localeCompare(a.m.startISO));
  return { configured: true, meetings: out };
}

export async function getMeetingSuggestions(
  daysBack = 7,
  daysForward = 7
): Promise<SuggestionsResult> {
  if (!calendarConfigured()) return { configured: false, upcoming: [], recent: [] };

  const [events, teamTokens] = await Promise.all([
    listPrimaryWindow(daysBack, daysForward),
    internalNameTokens(),
  ]);
  const best = new Map<string, MeetingSuggestion>();

  for (const ev of events) {
    if (/^grain data for/i.test(ev.title)) continue;
    const attendees = ev.attendees || [];
    if (attendees.length === 0 || attendees.length > 12) continue; // skip solo blocks + big group events

    const internalTokens = new Set<string>(teamTokens);
    let hasExternal = false;
    for (const a of attendees) {
      const dom = (a.email || "").split("@")[1]?.toLowerCase();
      if (!dom) continue;
      if (dom === INTERNAL_DOMAIN) {
        if (a.name) for (const t of normalize(a.name).split(" ")) if (t.length > 2) internalTokens.add(t);
      } else {
        hasExternal = true;
      }
    }
    if (!hasExternal) continue; // internal-only meeting

    const term = deriveTerm(ev.title, internalTokens);
    if (!term) continue;
    const key = normalize(term);
    if (!key) continue;

    const sug: MeetingSuggestion = {
      term,
      title: ev.title,
      date: ev.startISO.slice(0, 10),
      time: ev.allDay ? undefined : ev.startISO.slice(11, 16),
      // time-based: a meeting earlier today is already past
      upcoming: ev.upcoming,
    };

    // One entry per company: prefer an upcoming meeting (soonest); else the most recent.
    const prev = best.get(key);
    if (!prev) {
      best.set(key, sug);
    } else if (sug.upcoming && !prev.upcoming) {
      best.set(key, sug);
    } else if (sug.upcoming === prev.upcoming) {
      const better = sug.upcoming ? dtKey(sug) < dtKey(prev) : dtKey(sug) > dtKey(prev);
      if (better) best.set(key, sug);
    }
  }

  const all = [...best.values()];
  return {
    configured: true,
    upcoming: all.filter((s) => s.upcoming).sort((a, b) => dtKey(a).localeCompare(dtKey(b))),
    recent: all.filter((s) => !s.upcoming).sort((a, b) => dtKey(b).localeCompare(dtKey(a))),
  };
}

/** Sort key combining date + time (past meetings today sort by time, too). */
const dtKey = (s: MeetingSuggestion) => `${s.date} ${s.time || "00:00"}`;
