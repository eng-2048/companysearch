import { NextRequest } from "next/server";
import { SearchEvent } from "@/lib/types";
import { gatherContext } from "@/lib/gather";
import { findCandidates } from "@/lib/attio";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Streams a Context Bundle as NDJSON (one JSON event per line).
// Phase 1: real Attio data. Grain / Calendar / email are added in later phases;
// the streaming contract to the UI stays identical.

function line(evt: SearchEvent): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(evt) + "\n");
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const name = String(body?.query ?? "").trim();
  // Set when the user picked a specific record from the disambiguation list.
  const recordId = body?.recordId ? String(body.recordId) : undefined;

  const stream = new ReadableStream({
    async start(controller) {
      const send = (evt: SearchEvent) => controller.enqueue(line(evt));

      if (!name) {
        send({ type: "error", message: "Please enter a company or founder name." });
        send({ type: "done" });
        controller.close();
        return;
      }

      try {
        send({ type: "status", message: "Resolving the entity in Attio (companies + people)…" });

        // Unless the user already picked a record, check for an ambiguous name
        // (e.g. two "Etched" records) and let them choose instead of guessing.
        if (!recordId) {
          const options = await findCandidates(name);
          if (options.length >= 2) {
            send({ type: "candidates", query: name, options });
            send({ type: "done" });
            return;
          }
        }

        send({ type: "status", message: "Collecting record IDs, emails, and the deal_flow entry…" });

        const bundle = await gatherContext(name, { recordId });

        send({ type: "status", message: "Bundle assembled." });
        send({ type: "bundle", bundle });
        send({ type: "done" });
      } catch (err: any) {
        send({
          type: "error",
          message: err?.message ?? "Failed to gather context from Attio.",
        });
        send({ type: "done" });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
    },
  });
}
