import { NextRequest } from "next/server";
import { sendGmail } from "@/lib/gmail";
import { updateStatus } from "@/lib/attio";
import { PassSendResponse } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Send one email. This is the ONLY send path and it runs only on an explicit
// user action. While EMAIL_TEST_MODE is on (see lib/gmail), sendGmail hard-clamps
// the recipient to the test address regardless of what's passed here. For a pass
// email, optionally flip the deal To Pass -> Pass afterward.
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));

  const to = Array.isArray(body.to) ? body.to.filter((a: any) => a?.email) : [];
  const cc = Array.isArray(body.cc) ? body.cc.filter((a: any) => a?.email) : [];
  const subject = String(body.subject || "").trim();
  const text = String(body.body || "");

  if (!to.length) {
    return Response.json(
      { ok: false, sent: false, error: "No recipient" } as PassSendResponse,
      { status: 400 }
    );
  }
  if (!text.trim()) {
    return Response.json(
      { ok: false, sent: false, error: "Empty body" } as PassSendResponse,
      { status: 400 }
    );
  }

  try {
    const result = await sendGmail({
      to,
      cc,
      subject: subject || "Follow Up From 2048 Ventures",
      body: text,
      threadId: body.threadId || undefined,
      inReplyTo: body.inReplyTo || undefined,
      references: body.references || undefined,
    });

    if (!result.sent) {
      return Response.json(
        {
          ok: false,
          sent: false,
          testMode: result.testMode,
          actualTo: result.actualTo,
          intendedTo: result.intendedTo,
          intendedCc: result.intendedCc,
          error: result.error,
        } as PassSendResponse,
        { status: 502 }
      );
    }

    // Pass emails move the deal to Pass (only after a successful send).
    let statusFlipped = false;
    if (body.kind === "pass" && body.flipStatus && body.dealFlowEntryId) {
      try {
        await updateStatus(String(body.dealFlowEntryId), "Pass");
        statusFlipped = true;
      } catch {
        statusFlipped = false;
      }
    }

    return Response.json({
      ok: true,
      sent: true,
      testMode: result.testMode,
      actualTo: result.actualTo,
      intendedTo: result.intendedTo,
      intendedCc: result.intendedCc,
      statusFlipped,
    } as PassSendResponse);
  } catch (e: any) {
    return Response.json(
      { ok: false, sent: false, error: e?.message ?? "send failed" } as PassSendResponse,
      { status: 500 }
    );
  }
}
