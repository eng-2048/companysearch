// Google Drive reader (read-only) for pitch decks saved in Drive. Uses the shared
// Google OAuth token (needs the drive.readonly scope). Google Slides/Docs export
// as plain text; uploaded PDFs are downloaded and parsed. Everything else (or a
// deck behind Docsend / another host) returns accessible:false with a reason.

import { accessToken, calendarConfigured } from "./gcal";

const DRIVE = "https://www.googleapis.com/drive/v3";
const MAX_TEXT = 100_000; // chars of deck text to keep

export interface DeckText {
  accessible: boolean;
  text?: string;
  name?: string;
  note?: string; // why it couldn't be read
}

/** Pull the Drive file id out of the many Drive URL shapes. */
function driveFileId(url: string): string | undefined {
  const patterns = [
    /\/(?:file|presentation|document|spreadsheets)\/d\/([a-zA-Z0-9_-]{20,})/,
    /[?&]id=([a-zA-Z0-9_-]{20,})/,
    /\/d\/([a-zA-Z0-9_-]{20,})/,
  ];
  for (const re of patterns) {
    const m = url.match(re);
    if (m) return m[1];
  }
  return undefined;
}

/** Follow a shortlink (zpr.io, bit.ly, …) to its final URL to find a Drive id. */
async function resolveFinalUrl(url: string): Promise<string> {
  try {
    const r = await fetch(url, { redirect: "follow" });
    return r.url || url;
  } catch {
    return url;
  }
}

async function extractPdf(buf: ArrayBuffer): Promise<string> {
  try {
    // The /lib entry avoids pdf-parse's index.js debug harness (which reads a test
    // file at import and would throw in a server context).
    const mod: any = await import("pdf-parse/lib/pdf-parse.js");
    const pdfParse = mod.default || mod;
    const data = await pdfParse(Buffer.from(buf));
    return String(data?.text || "").replace(/\n{3,}/g, "\n\n").trim();
  } catch {
    return "";
  }
}

// Deck content doesn't change — cache by file id for the process lifetime.
const cache = new Map<string, DeckText>();

/** Read a deck's text from its URL. Best-effort; never throws. */
export async function deckTextFromUrl(url?: string): Promise<DeckText> {
  if (!url) return { accessible: false, note: "No deck on file." };
  if (!calendarConfigured()) return { accessible: false, note: "Google isn't connected." };

  let fileId = driveFileId(url);
  if (!fileId && !/(?:drive|docs)\.google\.com/.test(url)) {
    fileId = driveFileId(await resolveFinalUrl(url));
    if (!fileId) return { accessible: false, note: "The deck isn't stored in Google Drive, so it can't be read." };
  }
  if (!fileId) return { accessible: false, note: "Couldn't find a Drive file id in the deck link." };

  if (cache.has(fileId)) return cache.get(fileId)!;

  let token: string;
  try {
    token = await accessToken();
  } catch {
    return { accessible: false, note: "Google auth failed." };
  }
  const headers = { Authorization: `Bearer ${token}` };

  const metaRes = await fetch(
    `${DRIVE}/files/${fileId}?fields=id,name,mimeType&supportsAllDrives=true`,
    { headers, cache: "no-store" }
  );
  if (metaRes.status === 401 || metaRes.status === 403) {
    return {
      accessible: false,
      note: "Drive access isn't granted yet — add the drive.readonly scope and reconnect Google.",
    };
  }
  if (!metaRes.ok) return { accessible: false, note: `Drive metadata error (HTTP ${metaRes.status}).` };
  const meta = await metaRes.json();
  const mime = String(meta.mimeType || "");

  let result: DeckText;
  try {
    if (mime === "application/vnd.google-apps.presentation" || mime === "application/vnd.google-apps.document") {
      const r = await fetch(`${DRIVE}/files/${fileId}/export?mimeType=text/plain`, { headers, cache: "no-store" });
      const text = r.ok ? (await r.text()).trim() : "";
      result = text
        ? { accessible: true, name: meta.name, text }
        : { accessible: false, name: meta.name, note: "Deck exported no text." };
    } else if (mime === "application/pdf") {
      const r = await fetch(`${DRIVE}/files/${fileId}?alt=media&supportsAllDrives=true`, { headers, cache: "no-store" });
      const text = r.ok ? await extractPdf(await r.arrayBuffer()) : "";
      result = text
        ? { accessible: true, name: meta.name, text }
        : { accessible: false, name: meta.name, note: "The deck PDF had no extractable text (image-only slides)." };
    } else {
      result = { accessible: false, name: meta.name, note: `Deck file type isn't readable (${mime}).` };
    }
  } catch {
    result = { accessible: false, name: meta.name, note: "Failed to read the deck file." };
  }

  if (result.text && result.text.length > MAX_TEXT) {
    result.text = result.text.slice(0, MAX_TEXT) + "\n…[deck truncated]";
  }
  cache.set(fileId, result);
  return result;
}
