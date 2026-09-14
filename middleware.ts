import { NextRequest, NextResponse } from "next/server";

// Shared-password gate for the whole app. When APP_PASSWORD is unset (local dev),
// auth is disabled. When set (hosted), every route requires a session cookie whose
// value is sha256(APP_PASSWORD) — set by /api/login — or the same value in an
// `x-app-key` header (used by the in-process pre-warm job).

async function sha256hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function middleware(req: NextRequest) {
  const pw = process.env.APP_PASSWORD;
  if (!pw) return NextResponse.next(); // auth disabled

  const { pathname } = req.nextUrl;
  // Always-open: the login page + its API, Next internals, favicon.
  if (
    pathname === "/login" ||
    pathname === "/api/login" ||
    pathname.startsWith("/_next/") ||
    pathname === "/favicon.ico"
  ) {
    return NextResponse.next();
  }

  const expected = await sha256hex(pw);
  const cookie = req.cookies.get("sid")?.value;
  const header = req.headers.get("x-app-key");
  if (cookie === expected || header === expected) return NextResponse.next();

  // API calls get a clean 401; page navigations bounce to the login screen.
  if (pathname.startsWith("/api/")) {
    return new NextResponse("Unauthorized", { status: 401 });
  }
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.searchParams.set("next", pathname);
  return NextResponse.redirect(url);
}

// Run on everything except static assets (kept cheap).
export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
