// Gmail client (read) via the shared Google OAuth token. Reconstructs the email
// thread with a founder/company by searching the user's mailbox for their email
// addresses, then flags the intro (first message) and outcome (last message).
// Native Gmail — not Attio — so the same connection can later draft/send.

import { accessToken, calendarConfigured } from "./gcal";

const GMAIL_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";
const MAX_MESSAGES = 20;

export interface EmailMessage {
  date: string; // YYYY-MM-DD
  fromName: string;
  fromEmail?: string;
  to: string;
  subject: string;
  snippet: string;
  threadId: string;
}

export interface EmailResolution {
  configured: boolean; // Google creds present
  available: boolean; // Gmail API reachable (scope enabled + API on)
  messages: EmailMessage[];
  intro?: string; // first message, summarized
  outcome?: string; // last message, summarized
}

/** Gmail uses the same Google OAuth as Calendar. */
export const gmailConfigured = calendarConfigured;

function header(headers: any[], name: string): string {
  return headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value || "";
}

function splitFrom(from: string): { name: string; email?: string } {
  const m = from.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  if (m) return { name: m[1].trim() || m[2].trim(), email: m[2].trim().toLowerCase() };
  return { name: from.trim(), email: from.includes("@") ? from.trim().toLowerCase() : undefined };
}

async function apiGet(path: string, token: string): Promise<any> {
  const res = await fetch(GMAIL_BASE + path, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const err: any = new Error(`Gmail ${path} -> HTTP ${res.status}`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return res.json();
}

export async function resolveEmail(emails: string[]): Promise<EmailResolution> {
  const clean = [...new Set(emails.map((e) => e.trim().toLowerCase()).filter(Boolean))];
  if (!calendarConfigured()) return { configured: false, available: false, messages: [] };
  if (clean.length === 0) return { configured: true, available: true, messages: [] };

  const token = await accessToken();

  // Search for correspondence to/from any of the founder's addresses.
  const q = clean.map((e) => `from:${e} OR to:${e}`).join(" OR ");
  let ids: string[] = [];
  try {
    const list = await apiGet(
      `/messages?q=${encodeURIComponent(q)}&maxResults=${MAX_MESSAGES}`,
      token
    );
    ids = (list.messages || []).map((m: any) => m.id);
  } catch (e: any) {
    // 403 = Gmail API disabled or scope missing; report unavailable, don't crash.
    if (e.status === 403 || e.status === 401) {
      return { configured: true, available: false, messages: [] };
    }
    throw e;
  }

  if (ids.length === 0) return { configured: true, available: true, messages: [] };

  const metas = await Promise.all(
    ids.map((id) =>
      apiGet(
        `/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date`,
        token
      ).catch(() => null)
    )
  );

  const messages: EmailMessage[] = [];
  for (const m of metas) {
    if (!m) continue;
    const hs = m.payload?.headers || [];
    const from = splitFrom(header(hs, "From"));
    const dateMs = Number(m.internalDate) || Date.parse(header(hs, "Date")) || 0;
    messages.push({
      date: dateMs ? new Date(dateMs).toISOString().slice(0, 10) : "",
      fromName: from.name,
      fromEmail: from.email,
      to: header(hs, "To"),
      subject: header(hs, "Subject") || "(no subject)",
      snippet: (m.snippet || "").replace(/\s+/g, " ").trim(),
      threadId: m.threadId,
    });
  }

  messages.sort((a, b) => a.date.localeCompare(b.date));

  // Label a sender: "(2048)" for internal, the raw name otherwise.
  const who = (m?: EmailMessage) =>
    !m ? "" : `${m.fromName}${m.fromEmail?.endsWith("@2048.vc") ? " (2048)" : ""}`;
  const first = messages[0];
  const last = messages[messages.length - 1];
  const intro = first ? `${first.date} — ${who(first)}: ${first.subject}` : undefined;
  const outcome = last ? `${last.date} — ${who(last)}: ${last.subject}` : undefined;

  return { configured: true, available: true, messages, intro, outcome };
}
