// Durable "not needed" store for Form Entry — the meetings the user manually
// dismissed (e.g. a portfolio check-in that doesn't need a first-meeting form).
// Kept OUTSIDE .cache/ (the day-cache wipes non-today files), so dismissals
// persist across days and sessions.

import fs from "node:fs/promises";
import path from "node:path";

const DIR = path.join(process.cwd(), ".data");
const FILE = path.join(DIR, "form-dismissed.json");

export async function readDismissed(): Promise<Set<string>> {
  try {
    const arr = JSON.parse(await fs.readFile(FILE, "utf8"));
    return new Set(Array.isArray(arr) ? arr : []);
  } catch {
    return new Set();
  }
}

async function write(set: Set<string>): Promise<void> {
  try {
    await fs.mkdir(DIR, { recursive: true });
    await fs.writeFile(FILE, JSON.stringify([...set]), "utf8");
  } catch {
    /* best-effort */
  }
}

export async function addDismissed(key: string): Promise<void> {
  const s = await readDismissed();
  s.add(key);
  await write(s);
}

export async function removeDismissed(key: string): Promise<void> {
  const s = await readDismissed();
  s.delete(key);
  await write(s);
}
