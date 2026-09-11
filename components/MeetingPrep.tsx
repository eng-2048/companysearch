"use client";

import { useState } from "react";
import { PrepEntry, PrepLinks, PrepResult } from "@/lib/types";
import { to12h } from "@/lib/match";
import StatusSelect from "@/components/StatusSelect";

/** Shown on a meeting we couldn't match to Attio — paste the record URL to link it
 *  (remembered everywhere). Triggers a re-scan so the card fills in. */
function LinkToAttio({ m, onLinked }: { m: PrepEntry; onLinked: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function link() {
    const url = window.prompt(
      `Paste the Attio deal record URL for “${m.company || m.title}” ` +
        `(the company in your deal flow):`,
      "https://app.attio.com/2048-ventures/company/"
    );
    if (!url || !url.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/attio-link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: m.title, attendees: m.attendees, url: url.trim() }),
      });
      const j = await res.json();
      if (!j.ok) {
        setErr(j.error || "Link failed");
        setBusy(false);
        return;
      }
      onLinked(); // re-scan; the card resolves to the linked record
    } catch {
      setErr("Link failed");
      setBusy(false);
    }
  }

  return (
    <span className="pc-link-attio">
      <button className="prep-back" onClick={link} disabled={busy} type="button">
        {busy ? "Linking…" : "＋ Link to deal"}
      </button>
      {err && <span className="save-ind err">{err}</span>}
    </span>
  );
}

const LINK_LABELS: [keyof PrepLinks, string][] = [
  ["deck", "Deck"],
  ["ceoLinkedin", "CEO LinkedIn"],
  ["ctoLinkedin", "CTO LinkedIn"],
  ["website", "Website"],
  ["dealFolder", "Deal folder"],
  ["recording", "Recording"],
  ["attioRecord", "Attio Record"],
];

// The moves you make from a prep screen: keep the current status, bump it forward,
// or move it to Watch (which prompts for a follow-up date). Exact Attio titles.
const FORWARD_STATUSES = ["1st Screen", "Deep Dive", "Diligence", "Watch"];

function PrepCard({
  m,
  onRelink,
  onDismiss,
}: {
  m: PrepEntry;
  onRelink: () => void;
  onDismiss: () => void;
}) {
  const links = LINK_LABELS.filter(([k]) => m.links[k]);
  return (
    <div className="prep-card">
      <div className="pc-time">
        {m.time ? to12h(m.time) : "all day"}
        {m.upcoming && <span className="pill-up">soon</span>}
      </div>
      <div className="pc-body">
        <div className="pc-head">
          <h3>
            {m.company}
            {m.founder && !m.company.includes(m.founder) ? ` · ${m.founder}` : ""}
          </h3>
          <div className="pc-head-actions">
            {m.dealFlowEntryId ? (
              <StatusSelect
                entryId={m.dealFlowEntryId}
                status={m.status || ""}
                forwardStatuses={FORWARD_STATUSES}
              />
            ) : (
              // Not attached to deal_flow (Attio may still have found a company, but
              // it isn't in our pipeline) — let the user link the right deal record.
              <LinkToAttio m={m} onLinked={onRelink} />
            )}
            <button
              className="fe-x"
              onClick={onDismiss}
              type="button"
              title="Dismiss — moves to the Dismissed section at the bottom"
            >
              Dismiss
            </button>
          </div>
        </div>
        {m.description && <div className="pc-desc">{m.description}</div>}
        {links.length > 0 ? (
          <div className="pc-links">
            {links.map(([k, label]) => (
              <a key={k} href={m.links[k]} target="_blank" rel="noreferrer" className="pc-link">
                {label} ↗
              </a>
            ))}
          </div>
        ) : (
          <div className="pc-nolinks">No links on file in Attio.</div>
        )}
        {m.attendees.length > 0 && (
          <div className="pc-attendees">
            {m.attendees.map((a, j) => (
              <span key={j} className={a.rsvp === "declined" ? "att declined" : "att"}>
                {a.name || a.email}
                {a.rsvp && a.rsvp !== "accepted" ? ` (${a.rsvp === "needsAction" ? "no reply" : a.rsvp})` : ""}
                {j < m.attendees.length - 1 ? ", " : ""}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function fmtDate(d: string): string {
  const dt = new Date(d + "T00:00:00");
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diff = Math.round((dt.getTime() - today.getTime()) / 864e5);
  const label = dt.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
  const prefix = diff === 0 ? "Today · " : diff === 1 ? "Tomorrow · " : "";
  return prefix + label;
}

function fmtUpdated(iso?: string): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const sameDay = d >= today;
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return sameDay ? `Updated ${time}` : `Updated ${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })}, ${time}`;
}

export default function MeetingPrep({
  data,
  loading,
  onRefresh,
  onClose,
}: {
  data: PrepResult | null;
  loading: boolean;
  onRefresh: () => void;
  onClose: () => void;
}) {
  const totalMeetings = data?.days.reduce((n, d) => n + d.meetings.length, 0) ?? 0;
  const updated = fmtUpdated(data?.generatedAt);

  // Optimistic override of each meeting's persisted "dismissed" flag (Dismiss / Restore).
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});
  const keyOf = (date: string, m: PrepEntry) => `${date}|${m.time || ""}|${m.title}`;
  const isRemoved = (date: string, m: PrepEntry) => overrides[keyOf(date, m)] ?? !!m.dismissed;

  async function setDismiss(date: string, m: PrepEntry, dismissed: boolean) {
    const key = keyOf(date, m);
    setOverrides((prev) => ({ ...prev, [key]: dismissed }));
    try {
      await fetch("/api/meeting-prep/dismiss", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key, undo: !dismissed }),
      });
    } catch {
      /* optimistic; the store write is best-effort */
    }
  }

  const removed: { m: PrepEntry; date: string }[] = [];
  for (const day of data?.days ?? []) {
    for (const m of day.meetings) if (isRemoved(day.date, m)) removed.push({ m, date: day.date });
  }
  const activeTotal = totalMeetings - removed.length;

  return (
    <div className="prep">
      <div className="prep-head">
        <div className="prep-title">
          <h2>Meeting prep · next 3 days</h2>
          {updated && <span className="prep-updated">{updated}</span>}
        </div>
        <div className="prep-actions">
          <button className="prep-back" onClick={onRefresh} disabled={loading} title="Re-scan the calendar now">
            {loading && data ? "Refreshing…" : "↻ Refresh"}
          </button>
          <button className="prep-back" onClick={onClose}>
            ← Search
          </button>
        </div>
      </div>

      {loading && !data && (
        <div className="status-line">
          <span className="spinner" />
          <span>Scanning your calendar and pulling each company…</span>
        </div>
      )}

      {!loading && data && !data.configured && (
        <div className="empty-note">Google Calendar isn&apos;t connected.</div>
      )}

      {!loading && data && data.configured && totalMeetings === 0 && (
        <div className="empty-note">No external meetings in the next 3 days.</div>
      )}

      {!loading && data && data.configured && totalMeetings > 0 && activeTotal === 0 && (
        <div className="empty-note">All caught up — every meeting dismissed.</div>
      )}

      {!loading &&
        data &&
        data.days.map((day) => {
          const active = day.meetings.filter((m) => !isRemoved(day.date, m));
          // Hide a day whose meetings were all dismissed.
          if (day.meetings.length > 0 && active.length === 0) return null;
          return (
            <div className="prep-day" key={day.date}>
              <div className="prep-day-head">{fmtDate(day.date)}</div>
              {day.meetings.length === 0 ? (
                <div className="prep-day-empty">No external meetings.</div>
              ) : (
                active.map((m) => (
                  <PrepCard
                    m={m}
                    key={keyOf(day.date, m)}
                    onRelink={onRefresh}
                    onDismiss={() => setDismiss(day.date, m, true)}
                  />
                ))
              )}
            </div>
          );
        })}

      {!loading && removed.length > 0 && (
        <div className="prep-day fe-removed-section">
          <div className="prep-day-head">Dismissed · {removed.length}</div>
          {removed.map(({ m, date }) => (
            <div className="fe-removed-row" key={keyOf(date, m)}>
              <div className="fe-removed-info">
                <span className="fe-removed-label">
                  {m.company}
                  {m.founder && !m.company.includes(m.founder) ? ` · ${m.founder}` : ""}
                </span>
                <span className="fe-removed-when">
                  {fmtDate(date)}
                  {m.time ? ` · ${to12h(m.time)}` : ""}
                </span>
              </div>
              <button className="fe-undo" onClick={() => setDismiss(date, m, false)} type="button">
                Restore
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
