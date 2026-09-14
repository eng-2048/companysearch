// Durable "not needed" stores for the to-do-style lists (Form Entry, Pass/
// Follow-Up). Each named store is a JSON array of keys under .data/ — kept OUTSIDE
// .cache/ so the day-cache cleanup (which wipes non-today files) can't erase it.

import fs from "node:fs/promises";
import path from "node:path";

// Overridable so a hosted deploy can point it at a persistent disk (DATA_DIR).
const DIR = process.env.DATA_DIR || path.join(process.cwd(), ".data");
const fileFor = (store: string) => path.join(DIR, `${store}.json`);

export async function readDismissed(store: string): Promise<Set<string>> {
  try {
    const arr = JSON.parse(await fs.readFile(fileFor(store), "utf8"));
    return new Set(Array.isArray(arr) ? arr : []);
  } catch {
    return new Set();
  }
}

async function write(store: string, set: Set<string>): Promise<void> {
  try {
    await fs.mkdir(DIR, { recursive: true });
    await fs.writeFile(fileFor(store), JSON.stringify([...set]), "utf8");
  } catch {
    /* best-effort */
  }
}

export async function addDismissed(store: string, key: string): Promise<void> {
  const s = await readDismissed(store);
  s.add(key);
  await write(store, s);
}

export async function removeDismissed(store: string, key: string): Promise<void> {
  const s = await readDismissed(store);
  s.delete(key);
  await write(store, s);
}
