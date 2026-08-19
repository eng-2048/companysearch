// Gmail client (read) via the shared Google OAuth token. Reconstructs the email
// thread with a founder/company by searching the user's mailbox for their email
// addresses, then flags the intro (first message) and outcome (last message).
// Native Gmail — not Attio — so the same connection can later draft/send.

import { accessToken, calendarConfigured } from "./gcal";
import { PriorOutreach } from "./types";

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

// ————————————————————————————————————————————————————————————————
// Sending (gmail.compose scope). SAFETY: while EMAIL_TEST_MODE is true, EVERY
// outbound message is hard-clamped to TEST_RECIPIENT and all other recipients
// (cc/bcc) are stripped, so no real founder or introducer can be emailed during
// testing. The intended recipients are preserved for display and written into a
// banner at the top of the body. This is the single choke point for all sends —
// nothing else in the app calls the Gmail send API.
// ————————————————————————————————————————————————————————————————
export const EMAIL_TEST_MODE = true;
export const TEST_RECIPIENT = "zannali@gmail.com";

let cachedProfileEmail: string | null = null;
/** The account we send AS (the OAuth account — zann@2048.vc). */
export async function senderEmail(): Promise<string> {
  if (cachedProfileEmail) return cachedProfileEmail;
  const token = await accessToken();
  const p = await apiGet("/profile", token);
  cachedProfileEmail = p.emailAddress;
  return cachedProfileEmail!;
}

export interface ThreadRef {
  threadId: string;
  messageId?: string; // RFC822 Message-ID of the last message (for In-Reply-To)
  references?: string; // accumulated References header
  subject?: string; // subject of the thread (to build "Re: …")
}

/** The most recent email thread involving any of these addresses — used to reply
 *  in-thread (a pass follow-up, or the intro thread for close-the-loop). */
export async function findLatestThread(emails: string[]): Promise<ThreadRef | null> {
  const clean = [...new Set(emails.map((e) => e.trim().toLowerCase()).filter(Boolean))];
  if (!calendarConfigured() || clean.length === 0) return null;
  const token = await accessToken();
  const q = clean.map((e) => `from:${e} OR to:${e}`).join(" OR ");
  let list: any;
  try {
    list = await apiGet(`/messages?q=${encodeURIComponent(q)}&maxResults=10`, token);
  } catch {
    return null;
  }
  const msgs = list.messages || [];
  if (!msgs.length) return null;

  // Find the newest message and read its threading headers.
  const metas = await Promise.all(
    msgs.map((m: any) =>
      apiGet(
        `/messages/${m.id}?format=metadata&metadataHeaders=Message-ID&metadataHeaders=References&metadataHeaders=Subject&metadataHeaders=Date`,
        token
      ).catch(() => null)
    )
  );
  let best: any = null;
  for (const m of metas) {
    if (!m) continue;
    const t = Number(m.internalDate) || 0;
    if (!best || t > (Number(best.internalDate) || 0)) best = m;
  }
  if (!best) return null;
  const hs = best.payload?.headers || [];
  const messageId = header(hs, "Message-ID") || undefined;
  const priorRefs = header(hs, "References") || "";
  return {
    threadId: best.threadId,
    messageId,
    references: [priorRefs, messageId].filter(Boolean).join(" ").trim() || undefined,
    subject: header(hs, "Subject") || undefined,
  };
}

function encodeHeader(value: string): string {
  // RFC2047-encode non-ASCII header values; leave plain ASCII untouched.
  // eslint-disable-next-line no-control-regex
  if (/^[\x00-\x7F]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

function buildMime(opts: {
  from: string;
  to: string[];
  cc?: string[];
  subject: string;
  body: string;
  inReplyTo?: string;
  references?: string;
}): string {
  const lines: string[] = [];
  lines.push(`From: ${opts.from}`);
  lines.push(`To: ${opts.to.join(", ")}`);
  if (opts.cc && opts.cc.length) lines.push(`Cc: ${opts.cc.join(", ")}`);
  lines.push(`Subject: ${encodeHeader(opts.subject)}`);
  if (opts.inReplyTo) lines.push(`In-Reply-To: ${opts.inReplyTo}`);
  if (opts.references) lines.push(`References: ${opts.references}`);
  lines.push("MIME-Version: 1.0");
  lines.push('Content-Type: text/plain; charset="UTF-8"');
  lines.push("Content-Transfer-Encoding: 8bit");
  lines.push("");
  lines.push(opts.body);
  return lines.join("\r\n");
}

const b64url = (s: string): string =>
  Buffer.from(s, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export interface SendInput {
  to: { name?: string; email: string }[];
  cc?: { name?: string; email: string }[];
  subject: string;
  body: string;
  threadId?: string; // reply-in-thread
  inReplyTo?: string; // Message-ID of the message being replied to
  references?: string;
}

export interface SendResult {
  sent: boolean;
  testMode: boolean;
  actualTo: string[]; // what actually received it
  intendedTo: string[]; // what it WOULD have gone to in production
  intendedCc: string[];
  id?: string;
  threadId?: string;
  error?: string;
}

const fmtAddr = (a: { name?: string; email: string }): string =>
  a.name ? `${encodeHeader(a.name)} <${a.email}>` : a.email;

/**
 * Send an email as the OAuth account. In test mode the real recipients are
 * replaced by TEST_RECIPIENT (cc dropped) and noted in a banner — nothing reaches
 * a real founder/introducer. Callers must gate this behind explicit user consent.
 */
export async function sendGmail(input: SendInput): Promise<SendResult> {
  const intendedTo = input.to.map((a) => a.email).filter(Boolean);
  const intendedCc = (input.cc || []).map((a) => a.email).filter(Boolean);

  if (!calendarConfigured()) {
    return { sent: false, testMode: EMAIL_TEST_MODE, actualTo: [], intendedTo, intendedCc, error: "Google not configured" };
  }

  const from = await senderEmail();

  let to: string[];
  let cc: string[] | undefined;
  let body = input.body;
  if (EMAIL_TEST_MODE) {
    to = [TEST_RECIPIENT];
    cc = undefined; // never cc a real person during testing
    const banner =
      `[TEST MODE — not sent to the real recipient]\n` +
      `Would send to: ${intendedTo.join(", ") || "(none)"}` +
      (intendedCc.length ? `\ncc: ${intendedCc.join(", ")}` : "") +
      `\n\n----------------------------------------\n\n`;
    body = banner + body;
  } else {
    to = input.to.map(fmtAddr);
    cc = input.cc && input.cc.length ? input.cc.map(fmtAddr) : undefined;
  }

  if (to.length === 0) {
    return { sent: false, testMode: EMAIL_TEST_MODE, actualTo: [], intendedTo, intendedCc, error: "No recipient" };
  }

  const mime = buildMime({
    from: `Zann Ali <${from}>`,
    to,
    cc,
    subject: input.subject,
    body,
    inReplyTo: input.inReplyTo,
    references: input.references,
  });

  const token = await accessToken();
  const payload: any = { raw: b64url(mime) };
  if (input.threadId) payload.threadId = input.threadId;

  const res = await fetch(`${GMAIL_BASE}/messages/send`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    cache: "no-store",
  });
  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    return {
      sent: false,
      testMode: EMAIL_TEST_MODE,
      actualTo: to,
      intendedTo,
      intendedCc,
      error: `Gmail send HTTP ${res.status}: ${errBody.slice(0, 200)}`,
    };
  }
  const j = await res.json();
  return {
    sent: true,
    testMode: EMAIL_TEST_MODE,
    actualTo: to,
    intendedTo,
    intendedCc,
    id: j.id,
    threadId: j.threadId,
  };
}

// ————————————————————————————————————————————————————————————————
// Prior-outreach detection — before composing/sending, look through the mailbox
// for an email a 2048 teammate already sent this founder (a pass, a watch/keep-in-
// touch, or any outreach), so we never double-send and can surface "already sent".
// ————————————————————————————————————————————————————————————————

const b64urlDecode = (data: string): string => {
  try {
    return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
  } catch {
    return "";
  }
};

/** Extract readable text from a Gmail message payload (prefers text/plain). */
function extractText(payload: any): string {
  if (!payload) return "";
  if (payload.mimeType === "text/plain" && payload.body?.data) return b64urlDecode(payload.body.data);
  if (Array.isArray(payload.parts)) {
    const plain = payload.parts.find((p: any) => p.mimeType === "text/plain" && p.body?.data);
    if (plain) return b64urlDecode(plain.body.data);
    // fall back to HTML, stripped of tags
    const html = payload.parts.find((p: any) => p.mimeType === "text/html" && p.body?.data);
    if (html) return b64urlDecode(html.body.data).replace(/<[^>]+>/g, " ");
    for (const p of payload.parts) {
      const t = extractText(p);
      if (t) return t;
    }
  }
  if (payload.body?.data) return b64urlDecode(payload.body.data).replace(/<[^>]+>/g, " ");
  return "";
}

const PASS_RE =
  /won'?t be a fit|not a fit|isn'?t a fit|not the right fit|decided (not to|to pass|this won)|pass on this|won'?t be moving forward|won'?t be a match|not moving forward with an investment|didn'?t get there on an investment/i;
const WATCH_RE =
  /keep in touch|stay close|stay in touch|staying in touch|not in a position to move forward|circle back|love to follow|keep me posted|check back in/i;

/**
 * The most recent email a 2048 address sent to this founder, classified as a pass,
 * a watch, or generic outreach. Returns null if none found. Searches the connected
 * mailbox (catches your own sends and any thread you're on — including a teammate's
 * message when you were cc'd).
 */
export async function scanPriorOutreach(emails: string[]): Promise<PriorOutreach | null> {
  const clean = [...new Set(emails.map((e) => e.trim().toLowerCase()).filter((e) => e.includes("@")))];
  if (!calendarConfigured() || clean.length === 0) return null;
  const token = await accessToken();

  const to = clean.map((e) => `to:${e}`).join(" OR ");
  const q = `(${to}) from:2048.vc`;
  let ids: string[] = [];
  try {
    const list = await apiGet(`/messages?q=${encodeURIComponent(q)}&maxResults=8`, token);
    ids = (list.messages || []).map((m: any) => m.id);
  } catch {
    return null;
  }
  if (!ids.length) return null;

  // Newest first: fetch full message, classify by subject + body.
  const msgs = await Promise.all(
    ids.map((id) => apiGet(`/messages/${id}?format=full`, token).catch(() => null))
  );
  const scored = msgs
    .filter(Boolean)
    .map((m: any) => {
      const hs = m.payload?.headers || [];
      const from = splitFrom(header(hs, "From"));
      const subject = header(hs, "Subject") || "(no subject)";
      const dateMs = Number(m.internalDate) || Date.parse(header(hs, "Date")) || 0;
      const text = `${subject}\n${extractText(m.payload)}`;
      const kind: PriorOutreach["kind"] = PASS_RE.test(text)
        ? "pass"
        : WATCH_RE.test(text)
          ? "watch"
          : "outreach";
      return {
        kind,
        who: from.name || from.email || "a teammate",
        date: dateMs ? new Date(dateMs).toISOString().slice(0, 10) : "",
        subject,
        ms: dateMs,
      };
    })
    .sort((a, b) => b.ms - a.ms);

  // Only warn about a PASS or WATCH already sent — generic prior outreach
  // (scheduling, intros) is normal and shouldn't raise an alarm.
  const decisive = scored.find((s) => s.kind === "pass" || s.kind === "watch");
  if (!decisive) return null;
  return { kind: decisive.kind, who: decisive.who, date: decisive.date, subject: decisive.subject };
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
