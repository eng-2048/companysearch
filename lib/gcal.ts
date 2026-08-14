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

async function listEvents(query: string, timeMin: string, timeMax: string): Promise<any[]> {
  const token = await accessToken();
  const params = new URLSearchParams({
    q: query,
    timeMin,
    timeMax,
    singleEvents: "true",
    orderBy: "startTime",
    maxResults: "25",
  });
  const res = await fetch(`${CAL_BASE}/calendars/primary/events?${params}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`Calendar list failed: HTTP ${res.status} ${await res.text().catch(() => "")}`);
  }
  const json = await res.json();
  return json.items || [];
}

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

  const now = new Date();
  const nowMs = now.getTime();
  const timeMin = new Date(nowMs - PAST_WINDOW_DAYS * 864e5).toISOString();
  const timeMax = new Date(nowMs + FUTURE_WINDOW_DAYS * 864e5).toISOString();

  const queries = [...new Set([...emails, ...terms].map((s) => s.trim()).filter(Boolean))];
  const emailSet = new Set(emails.map((e) => e.toLowerCase()));

  const lists = await Promise.all(
    queries.map((q) => listEvents(q, timeMin, timeMax).catch(() => []))
  );

  const byId = new Map<string, any>();
  for (const list of lists) for (const ev of list) if (ev?.id) byId.set(ev.id, ev);

  const events: GCalEvent[] = [];
  for (const raw of byId.values()) {
    const attendeeEmails: string[] = (raw.attendees || [])
      .map((a: any) => (a.email || "").toLowerCase())
      .filter(Boolean);
    const emailMatch = attendeeEmails.some((e: string) => emailSet.has(e));
    const titleMatch = terms.some((t) => wholeWordMatch(raw.summary || "", t));
    if (emailMatch || titleMatch) events.push(parseEvent(raw, nowMs));
  }

  events.sort((a, b) => a.startISO.localeCompare(b.startISO));
  return { events, configured: true };
}
