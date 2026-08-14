// Meeting-derived search pre-selects: "your meetings this week" → clickable
// entries that launch a company-search. Built from the user's own calendar
// (primary), filtered to external deal meetings, with the company/founder
// inferred from the meeting title (2048's titling conventions).

import { listPrimaryWindow, calendarConfigured, internalNameTokens } from "./gcal";
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

export async function getMeetingSuggestions(
  daysBack = 7,
  daysForward = 7
): Promise<SuggestionsResult> {
  if (!calendarConfigured()) return { configured: false, upcoming: [], recent: [] };

  const [events, teamTokens] = await Promise.all([
    listPrimaryWindow(daysBack, daysForward),
    internalNameTokens(),
  ]);
  const todayStr = new Date().toISOString().slice(0, 10);
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

    const day = ev.startISO.slice(0, 10);
    const sug: MeetingSuggestion = {
      term,
      title: ev.title,
      date: day,
      time: ev.allDay ? undefined : ev.startISO.slice(11, 16),
      upcoming: day >= todayStr,
    };

    // One entry per company: prefer an upcoming meeting (soonest); else the most recent.
    const prev = best.get(key);
    if (!prev) {
      best.set(key, sug);
    } else if (sug.upcoming && !prev.upcoming) {
      best.set(key, sug);
    } else if (sug.upcoming === prev.upcoming) {
      const better = sug.upcoming ? sug.date < prev.date : sug.date > prev.date;
      if (better) best.set(key, sug);
    }
  }

  const all = [...best.values()];
  return {
    configured: true,
    upcoming: all.filter((s) => s.upcoming).sort((a, b) => a.date.localeCompare(b.date)),
    recent: all.filter((s) => !s.upcoming).sort((a, b) => b.date.localeCompare(a.date)),
  };
}
