// Manual meeting → Attio record links. When automatic resolution can't tell what
// a meeting is about (an abbreviation like "[AFC]" for Alpha Fit Club, only a
// gmail attendee), the user pastes the Attio URL once and we remember it —
// everywhere (Meeting Prep, Form Entry, Pass/Follow-Up all resolve through this).
//
// Durable under .data/ (outside .cache/ so the day-cache cleanup can't wipe it).
// Keyed BOTH by the normalized meeting title AND each external attendee email, so
// a future meeting with the same title or the same person resolves too.

import fs from "node:fs/promises";
import path from "node:path";
import { normalize } from "./match";

const DIR = path.join(process.cwd(), ".data");
const FILE = path.join(DIR, "attio-links.json");

interface Link {
  recordId: string;
  name?: string;
}

async function readMap(): Promise<Record<string, Link>> {
  try {
    const j = JSON.parse(await fs.readFile(FILE, "utf8"));
    return j && typeof j === "object" ? j : {};
  } catch {
    return {};
  }
}

async function writeMap(m: Record<string, Link>): Promise<void> {
  try {
    await fs.mkdir(DIR, { recursive: true });
    await fs.writeFile(FILE, JSON.stringify(m), "utf8");
  } catch {
    /* best-effort */
  }
}

type Attendee = { name?: string; email?: string };

/** The keys a meeting is stored/looked-up under: its title + each external email. */
export function linkKeys(title: string, attendees: Attendee[] = []): string[] {
  const keys = new Set<string>();
  const t = normalize(title || "");
  if (t) keys.add(`t:${t}`);
  for (const a of attendees) {
    const e = (a.email || "").trim().toLowerCase();
    if (e && e.includes("@") && !e.endsWith("@2048.vc")) keys.add(`e:${e}`);
  }
  return [...keys];
}

/** The manually-linked Attio record id for this meeting, if any. */
export async function resolveLink(title: string, attendees: Attendee[] = []): Promise<string | undefined> {
  const m = await readMap();
  for (const k of linkKeys(title, attendees)) {
    if (m[k]) return m[k].recordId;
  }
  return undefined;
}

export async function setLink(
  title: string,
  attendees: Attendee[],
  recordId: string,
  name?: string
): Promise<void> {
  const m = await readMap();
  const link: Link = { recordId, name };
  for (const k of linkKeys(title, attendees)) m[k] = link;
  await writeMap(m);
}

export async function removeLink(title: string, attendees: Attendee[] = []): Promise<void> {
  const m = await readMap();
  for (const k of linkKeys(title, attendees)) delete m[k];
  await writeMap(m);
}

/** Pull the record id out of an Attio company/person URL. */
export function recordIdFromUrl(url: string): string | undefined {
  const m = String(url || "").match(/\/(?:company|companies|person|people)\/([0-9a-f-]{36})/i);
  return m ? m[1] : undefined;
}
