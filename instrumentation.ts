// Next.js server startup hook. Starts the daily pre-warm scheduler on the Node
// server when ENABLE_CRON=1 (set on the hosted deploy; off in local dev).

export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.ENABLE_CRON !== "1") return;
  const { startDailyPrewarm } = await import("./lib/prewarm");
  startDailyPrewarm();
}
