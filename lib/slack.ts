// Slack context layer. 2048 keeps a private #deals-<company> channel for many
// deals; this reads that channel as extra context for Company Search Q&A. Matching
// is name-first (deals-<company>) then VERIFIED by the Attio record link posted in
// the channel (the first-meeting form), so we don't feed the wrong company's
// context. Uses a user token (xoxp-) so it can see the private channels Zann is in.

import { squish } from "./match";

const SLACK = "https://slack.com/api";

export const slackConfigured = (): boolean => !!process.env.SLACK_USER_TOKEN;

async function api(method: string, params: Record<string, string | number | boolean | undefined> = {}): Promise<any> {
  const token = process.env.SLACK_USER_TOKEN;
  if (!token) throw new Error("SLACK_USER_TOKEN not set");
  const url = new URL(`${SLACK}/${method}`);
  for (const [k, v] of Object.entries(params)) if (v != null) url.searchParams.set(k, String(v));
  const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });
  const j = await res.json();
  if (!j.ok) throw new Error(`Slack ${method}: ${j.error || "unknown error"}`);
  return j;
}

interface Channel {
  id: string;
  name: string;
  is_archived: boolean;
}

// Channel list and user directory are stable-ish; cache briefly to keep it snappy.
let channelsCache: { at: number; channels: Channel[] } | null = null;
let usersCache: { at: number; map: Record<string, string> } | null = null;

async function listChannels(): Promise<Channel[]> {
  if (channelsCache && Date.now() - channelsCache.at < 300_000) return channelsCache.channels;
  const out: Channel[] = [];
  let cursor: string | undefined;
  do {
    const j = await api("conversations.list", {
      types: "public_channel,private_channel",
      exclude_archived: false,
      limit: 1000,
      cursor,
    });
    for (const c of j.channels || []) out.push({ id: c.id, name: c.name, is_archived: !!c.is_archived });
    cursor = j.response_metadata?.next_cursor || undefined;
  } while (cursor);
  channelsCache = { at: Date.now(), channels: out };
  return out;
}

async function userMap(): Promise<Record<string, string>> {
  if (usersCache && Date.now() - usersCache.at < 600_000) return usersCache.map;
  const map: Record<string, string> = {};
  let cursor: string | undefined;
  try {
    do {
      const j = await api("users.list", { limit: 200, cursor });
      for (const u of j.members || []) {
        map[u.id] = u.profile?.real_name || u.profile?.display_name || u.name || u.id;
      }
      cursor = j.response_metadata?.next_cursor || undefined;
    } while (cursor);
  } catch {
    /* names are a nicety */
  }
  usersCache = { at: Date.now(), map };
  return map;
}

async function history(channelId: string, cap = 800): Promise<any[]> {
  const msgs: any[] = [];
  let cursor: string | undefined;
  do {
    const j = await api("conversations.history", { channel: channelId, limit: 200, cursor });
    for (const m of j.messages || []) msgs.push(m);
    cursor = j.response_metadata?.next_cursor || undefined;
  } while (cursor && msgs.length < cap);
  return msgs; // newest first
}

/** Flatten a Slack message's readable text (top-level + blocks + attachments). */
function collectText(obj: any, acc: string[]): void {
  if (!obj || typeof obj !== "object") return;
  if (Array.isArray(obj)) {
    for (const x of obj) collectText(x, acc);
    return;
  }
  if (typeof obj.text === "string") acc.push(obj.text);
  for (const k of Object.keys(obj)) if (obj[k] && typeof obj[k] === "object") collectText(obj[k], acc);
}
function messageText(m: any): string {
  const acc: string[] = [];
  if (typeof m.text === "string") acc.push(m.text);
  collectText(m.blocks, acc);
  collectText(m.attachments, acc);
  return [...new Set(acc)].join(" ").replace(/\s+/g, " ").trim();
}

const ATTIO_ID_RE = /\/(?:company|companies|person|people)\/([0-9a-f-]{36})/gi;

export interface SlackContext {
  found: boolean;
  channelName?: string;
  verified?: "match" | "mismatch" | "name-only";
  note?: string;
  text?: string; // formatted channel messages, only when safe to use
}

const MAX_SLACK_TEXT = 60_000;

/**
 * Find and read the #deals-<company> channel for a resolved company. Name-match
 * candidates, then verify by the Attio record id posted in the channel: a MATCH is
 * used with confidence; a MISMATCH (channel points at a different record) is
 * surfaced but NOT used as context; a name-only match (no link to check) is used
 * with a caveat.
 */
export async function slackContextForCompany(company: string, recordId?: string): Promise<SlackContext> {
  if (!slackConfigured()) return { found: false };

  let channels: Channel[];
  try {
    channels = await listChannels();
  } catch (e: any) {
    return { found: false, note: `Slack unreachable: ${e?.message || "error"}` };
  }

  const target = squish(company);
  if (!target) return { found: false };

  const scored = channels
    .filter((c) => c.name.startsWith("deals-"))
    .map((c) => {
      const slug = squish(c.name.replace(/^deals-/, ""));
      let score = 0;
      if (slug && slug === target) score = 3;
      else if (slug && (slug.startsWith(target) || target.startsWith(slug))) score = 2;
      else if (slug && Math.min(slug.length, target.length) >= 4 && (slug.includes(target) || target.includes(slug)))
        score = 1;
      return { c, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);

  if (!scored.length) return { found: false, note: `No #deals-* channel matched "${company}".` };

  // Read candidates; prefer a channel whose posted Attio link matches this record.
  let best: { c: Channel; msgs: any[]; verified: SlackContext["verified"] } | null = null;
  for (const { c } of scored.slice(0, 4)) {
    let msgs: any[];
    try {
      msgs = await history(c.id);
    } catch {
      continue;
    }
    const blob = msgs.map((m) => JSON.stringify(m)).join(" ");
    const ids = [...blob.matchAll(ATTIO_ID_RE)].map((m) => m[1].toLowerCase());
    const hasThis = !!recordId && ids.includes(recordId.toLowerCase());
    const hasOther = !!recordId && ids.length > 0 && !hasThis;
    const verified: SlackContext["verified"] = hasThis ? "match" : hasOther ? "mismatch" : "name-only";
    const cand = { c, msgs, verified };
    if (verified === "match") {
      best = cand;
      break;
    }
    // Prefer a name-only candidate over a mismatched one.
    if (!best || (best.verified === "mismatch" && verified === "name-only")) best = cand;
  }
  if (!best) return { found: false, note: "Matched a #deals-* channel by name but couldn't read it." };

  const channelName = `#${best.c.name}${best.c.is_archived ? " (archived)" : ""}`;

  if (best.verified === "mismatch") {
    return {
      found: true,
      channelName,
      verified: "mismatch",
      note: `A ${channelName} channel exists but the Attio link posted there points to a DIFFERENT record than the one resolved — not using it as context (verify you have the right company).`,
    };
  }

  const users = await userMap();
  let text = [...best.msgs]
    .reverse()
    .map((m) => {
      const who = m.user ? users[m.user] || m.user : m.username || (m.bot_id ? "bot" : "unknown");
      const when = m.ts ? new Date(Number(m.ts) * 1000).toISOString().slice(0, 10) : "";
      const body = messageText(m);
      return body ? `${when} ${who}: ${body}` : "";
    })
    .filter(Boolean)
    .join("\n");
  if (text.length > MAX_SLACK_TEXT) text = text.slice(-MAX_SLACK_TEXT); // keep the most recent

  const note =
    best.verified === "match"
      ? `${channelName} — Attio link in the channel matches the resolved record (verified).`
      : `${channelName} — matched by name; no Attio link found in the channel to verify.`;

  return { found: true, channelName, verified: best.verified, note, text };
}
