import { NextRequest } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function sha256hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Verify the shared password and set the session cookie (sha256 of the password,
// httpOnly). Matches the check in middleware.ts.
export async function POST(req: NextRequest) {
  const pw = process.env.APP_PASSWORD;
  if (!pw) return Response.json({ ok: true }); // auth disabled
  const { password } = await req.json().catch(() => ({}));
  if (typeof password !== "string" || password !== pw) {
    return Response.json({ ok: false, error: "Wrong password" }, { status: 401 });
  }
  const res = Response.json({ ok: true });
  res.headers.append(
    "Set-Cookie",
    `sid=${await sha256hex(pw)}; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=${60 * 60 * 24 * 30}`
  );
  return res;
}
