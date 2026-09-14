// Generic server-side day cache. Expensive scans (Meeting Prep, Form Entry list,
// per-meeting drafts) are computed at most once per day and served from a JSON
// file under .cache/ (gitignored) on every subsequent request. Keyed by an
// arbitrary string, auto-scoped to the local date; a `refresh` bypasses it.

import { promises as fs } from "fs";
import path from "path";

// Overridable so a hosted deploy can point it at a persistent disk (CACHE_DIR).
const CACHE_DIR = process.env.CACHE_DIR || path.join(process.cwd(), ".cache");

/** Local YYYY-MM-DD (server clock = the user's machine). */
export function localDateKey(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate()
  ).padStart(2, "0")}`;
}

const sanitize = (k: string) => k.replace(/[^a-z0-9._-]/gi, "_").slice(0, 180);
const fileFor = (key: string, dateKey = localDateKey()): string =>
  path.join(CACHE_DIR, `${sanitize(key)}__${dateKey}.json`);

export interface DayCached<T> {
  generatedAt: string; // ISO timestamp of the scan
  value: T;
}

export async function readDayCache<T>(key: string): Promise<DayCached<T> | null> {
  try {
    return JSON.parse(await fs.readFile(fileFor(key), "utf8")) as DayCached<T>;
  } catch {
    return null; // no cache for today (or unreadable) — caller recomputes
  }
}

export async function writeDayCache<T>(key: string, value: T, generatedAt: string): Promise<void> {
  try {
    await fs.mkdir(CACHE_DIR, { recursive: true });
    await fs.writeFile(fileFor(key), JSON.stringify({ generatedAt, value }), "utf8");
    await cleanupStale(); // drop everything from previous days
  } catch {
    /* cache is best-effort — never fail the request on a write error */
  }
}

/** Small stable hash for building cache keys from a meeting's identity. */
export function hashKey(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

async function cleanupStale(): Promise<void> {
  try {
    const today = `__${localDateKey()}.json`;
    const entries = await fs.readdir(CACHE_DIR);
    await Promise.all(
      entries
        .filter((f) => f.endsWith(".json") && !f.endsWith(today))
        .map((f) => fs.unlink(path.join(CACHE_DIR, f)).catch(() => {}))
    );
  } catch {
    /* ignore */
  }
}
