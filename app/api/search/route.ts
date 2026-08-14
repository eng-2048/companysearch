import { NextRequest } from "next/server";
import { MOCK_BUNDLE } from "@/lib/mockData";
import { SearchEvent } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Phase 0: this endpoint streams a mock Context Bundle with realistic progress
// lines. In Phase 1 the body of `gather()` is replaced with a live Claude Agent
// SDK run that loads the company-search SKILL.md and reaches Attio / Grain /
// Calendar over MCP — the streaming contract to the UI stays identical.

function encoder() {
  const enc = new TextEncoder();
  return (evt: SearchEvent) => enc.encode(JSON.stringify(evt) + "\n");
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function POST(req: NextRequest) {
  const { query } = await req.json().catch(() => ({ query: "" }));
  const name = String(query ?? "").trim();

  const line = encoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (evt: SearchEvent) => controller.enqueue(line(evt));

      if (!name) {
        send({ type: "error", message: "Please enter a company or founder name." });
        send({ type: "done" });
        controller.close();
        return;
      }

      // Mirror the skill's two-phase execution model as progress lines.
      const steps = [
        "Resolving the entity in Attio (companies + people)…",
        "Pulling the deal_flow list entry and email set…",
        "Fanning out: Calendar, Grain, email, Attio notes…",
        "Reconciling into one timeline…",
      ];
      for (const s of steps) {
        send({ type: "status", message: s });
        await sleep(650);
      }

      // In Phase 0 we always return the same mock, but echo the query so it's
      // clear the input flowed through.
      const bundle = { ...MOCK_BUNDLE };
      send({ type: "status", message: "Bundle assembled." });
      send({ type: "bundle", bundle });
      send({ type: "done" });
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
    },
  });
}
