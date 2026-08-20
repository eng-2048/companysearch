import { NextRequest } from "next/server";
import { setLink, removeLink, recordIdFromUrl } from "@/lib/attioLinks";
import { getCompanyName } from "@/lib/attio";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Manually link a meeting to an Attio record (or unlink). The link is keyed by the
// meeting title + attendee emails and applied by every module's resolver, so once
// set the meeting resolves to this record everywhere.
export async function POST(req: NextRequest) {
  const { title, attendees, url, unlink } = await req.json().catch(() => ({}));
  if (!title) return Response.json({ ok: false, error: "title required" }, { status: 400 });
  const atts = Array.isArray(attendees) ? attendees : [];

  try {
    if (unlink) {
      await removeLink(String(title), atts);
      return Response.json({ ok: true, unlinked: true });
    }
    const recordId = recordIdFromUrl(String(url || ""));
    if (!recordId) {
      return Response.json(
        { ok: false, error: "Couldn't find an Attio record id in that URL." },
        { status: 400 }
      );
    }
    let name: string | undefined;
    try {
      name = await getCompanyName(recordId);
    } catch {
      /* name is a nicety; linking still works without it */
    }
    await setLink(String(title), atts, recordId, name);
    return Response.json({ ok: true, recordId, name });
  } catch (e: any) {
    return Response.json({ ok: false, error: e?.message ?? "failed" }, { status: 500 });
  }
}
