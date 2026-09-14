// Daily pre-warm: just before the workday, run the heavy scans so their day-cache
// is already built and the app opens instantly instead of paying the cold-scan
// cost. Dependency-free and DST-correct (we read the wall-clock time in ET via
// Intl, so 7:00 ET is always 7:00 ET whether it's EST or EDT).
//
// Started once from instrumentation.ts on the Node server (ENABLE_CRON=1).

const TZ = "America/New_York";
const HOUR = Number(process.env.PREWARM_HOUR ?? 7); // 24h ET
const PATHS = ["/api/meeting-prep?refresh=1", "/api/form-entry?refresh=1", "/api/suggestions"];

let started = false;
let lastRunDate = "";

/** Wall-clock date + hour + minute in ET, right now. */
function etNow(): { date: string; hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date());
  const g = (t: string) => parts.find((p) => p.type === t)?.value || "";
  const hour = Number(g("hour")) % 24; // Intl can emit "24" at midnight
  return { date: `${g("year")}-${g("month")}-${g("day")}`, hour, minute: Number(g("minute")) };
}

async function sha256hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function runPrewarm(): Promise<void> {
  const base = process.env.SELF_URL || `http://127.0.0.1:${process.env.PORT || 3000}`;
  // The gate (middleware) accepts this header as a valid session.
  const headers: Record<string, string> = {};
  if (process.env.APP_PASSWORD) {
    headers["x-app-key"] = await sha256hex(process.env.APP_PASSWORD);
  }
  for (const path of PATHS) {
    try {
      const t0 = Date.now();
      const res = await fetch(base + path, { headers, cache: "no-store" });
      console.log(`[prewarm] ${path} -> ${res.status} in ${Date.now() - t0}ms`);
    } catch (e: any) {
      console.error(`[prewarm] ${path} failed: ${e?.message || e}`);
    }
  }
}

export function startDailyPrewarm(): void {
  if (started) return;
  started = true;
  console.log(`[prewarm] scheduled daily at ${HOUR}:00 ${TZ}`);
  const tick = () => {
    const { date, hour, minute } = etNow();
    if (hour === HOUR && minute === 0 && lastRunDate !== date) {
      lastRunDate = date;
      void runPrewarm();
    }
  };
  const timer = setInterval(tick, 60_000); // check once a minute
  // Don't hold the process open just for the scheduler.
  (timer as any).unref?.();
}
