import { listStatuses } from "@/lib/attio";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The deal_flow pipeline status options, for the status dropdown.
export async function GET() {
  return Response.json({ statuses: await listStatuses() });
}
