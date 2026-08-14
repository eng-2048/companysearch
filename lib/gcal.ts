// Google Calendar client (read-only) via OAuth refresh token.
//
// Auth: a one-time consent (scripts/google-auth.mjs) yields GOOGLE_REFRESH_TOKEN;
// here we exchange it for short-lived access tokens and call the Calendar API.
// Matching mirrors the skill's Step 2: query by founder name AND by each email
// (invites often omit the name from the title but always carry the attendee
// email), then keep events confirmed by an attendee-email match or a whole-word
// title match.

import { wholeWordMatch } from "./match";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const CAL_BASE = "https://www.googleapis.com/calendar/v3";
const PAST_WINDOW_DAYS = 120;
const FUTURE_WINDOW_DAYS = 60;

export interface GCalAttendee {
  name?: string;
  email?: string;
  responseStatus?: string; // accepted / declined / tentative / needsAction
  optional?: boolean;
  organizer?: boolean;
}

export interface GCalEvent {
  id: string;
  title: string;
  startISO: string;
  endISO?: string;
  allDay: boolean;
  upcoming: boolean;
  attendees: GCalAttendee[];
  organizerEmail?: string;
  htmlLink?: string;
}

export interface CalendarResolution {
  events: GCalEvent[];
  configured: boolean; // false when Google isn't set up yet
}

function creds() {
  return {
    id: process.env.GOOGLE_CLIENT_ID,
    secret: process.env.GOOGLE_CLIENT_SECRET,
    refresh: process.env.GOOGLE_REFRESH_TOKEN,
  };
}

export function calendarConfigured(): boolean {
  const c = creds();
  return !!(c.id && c.secret && c.refresh);
}

// Cache the access token in-module for its lifetime.
let cachedToken: { token: string; expiresAt: number } | null = null;

async function accessToken(): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expiresAt - 60_000) {
    return cachedToken.token;
  }
  const c = creds();
  const body = new URLSearchParams({
    client_id: c.id!,
    client_secret: c.secret!,
    refresh_token: c.refresh!,
    grant_type: "refresh_token",
  });
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`Google token refresh failed: HTTP ${res.status} ${await res.text().catch(() => "")}`);
  }
  const json = await res.json();
  cachedToken = {
    token: json.access_token,
    expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000,
  };
  return cachedToken.token;
}

/** Calendars the token can read events from (skip free/busy-only calendars). */
async function listCalendars(token: string): Promise<string[]> {
  const res = await fetch(`${CAL_BASE}/users/me/calendarList`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  if (!res.ok) return ["primary"];
  const json = await res.json();
  const ids = (json.items || [])
    .filter((c: any) => ["owner", "writer", "reader"].includes(c.accessRole))
    // holiday/birthday calendars never hold deal meetings and just add calls
    .filter((c: any) => !/holiday|birthday/i.test(c.id || ""))
    .map((c: any) => c.id);
  return ids.length ? ids : ["primary"];
}

async function listEvents(
  calendarId: string,
  query: string,
  timeMin: string,
  timeMax: string,
  token: string
): Promise<any[]> {
  const params = new URLSearchParams({
    q: query,
    timeMin,
    timeMax,
    singleEvents: "true",
    orderBy: "startTime",
    maxResults: "25",
  });
  const res = await fetch(
    `${CAL_BASE}/calendars/${encodeURIComponent(calendarId)}/events?${params}`,
    { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" }
  );
  if (!res.ok) return []; // a single calendar failing shouldn't sink the whole search
  const json = await res.json();
  return json.items || [];
}

const isGrainBotEvent = (raw: any): boolean =>
  /^grain data for/i.test(raw.summary || "");

function parseEvent(raw: any, nowMs: number): GCalEvent {
  const startISO = raw.start?.dateTime || raw.start?.date || "";
  const startMs = startISO ? new Date(startISO).getTime() : 0;
  return {
    id: raw.id,
    title: raw.summary || "(no title)",
    startISO,
    endISO: raw.end?.dateTime || raw.end?.date,
    allDay: !raw.start?.dateTime,
    upcoming: startMs > nowMs,
    attendees: (raw.attendees || []).map((a: any) => ({
      name: a.displayName || undefined,
      email: a.email || undefined,
      responseStatus: a.responseStatus,
      optional: a.optional || false,
      organizer: a.organizer || false,
    })),
    organizerEmail: raw.organizer?.email,
    htmlLink: raw.htmlLink,
  };
}

/**
 * Find calendar events for a company/founder.
 * @param terms   names to match against titles (company, founder)
 * @param emails  founder/co-founder emails — the reliable attendee key
 */
export async function resolveCalendar(
  terms: string[],
  emails: string[]
): Promise<CalendarResolution> {
  if (!calendarConfigured()) return { events: [], configured: false };

  const token = await accessToken();
  const now = new Date();
  const nowMs = now.getTime();
  const timeMin = new Date(nowMs - PAST_WINDOW_DAYS * 864e5).toISOString();
  const timeMax = new Date(nowMs + FUTURE_WINDOW_DAYS * 864e5).toISOString();

  const queries = [...new Set([...emails, ...terms].map((s) => s.trim()).filter(Boolean))];
  const emailSet = new Set(emails.map((e) => e.toLowerCase()));

  // Search every accessible calendar (2048 shares team calendars — a meeting a
  // colleague took with the founder is still firm context), all queries in parallel.
  const calendars = await listCalendars(token);
  const pairs = calendars.flatMap((cal) => queries.map((q) => ({ cal, q })));
  const lists = await Promise.all(pairs.map((p) => listEvents(p.cal, p.q, timeMin, timeMax, token)));

  // Dedupe the same meeting across calendars (each calendar holds its own copy;
  // they share an iCalUID).
  const byKey = new Map<string, any>();
  for (const list of lists) {
    for (const ev of list) {
      const kkey = ev.iCalUID || `${ev.start?.dateTime || ev.start?.date}|${ev.summary}`;
      if (!byKey.has(kkey)) byKey.set(kkey, ev);
    }
  }

  // A deal meeting is ABOUT the founder — a small meeting. Big internal group
  // events (e.g. "2048 Fellows: Deal Discuss") merely have the founder's email in
  // a long attendee list; those must name the company/founder in the title to count.
  const SMALL_MEETING = 10;

  const events: GCalEvent[] = [];
  for (const raw of byKey.values()) {
    if (isGrainBotEvent(raw)) continue;
    const attendees = raw.attendees || [];
    const attendeeEmails: string[] = attendees
      .map((a: any) => (a.email || "").toLowerCase())
      .filter(Boolean);
    const emailMatch = attendeeEmails.some((e: string) => emailSet.has(e));
    const titleMatch = terms.some((t) => wholeWordMatch(raw.summary || "", t));
    const keep =
      (titleMatch && attendees.length > 0) ||
      (emailMatch && attendees.length <= SMALL_MEETING);
    if (keep) events.push(parseEvent(raw, nowMs));
  }

  events.sort((a, b) => a.startISO.localeCompare(b.startISO));
  return { events, configured: true };
}
