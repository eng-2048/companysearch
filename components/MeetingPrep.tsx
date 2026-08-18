"use client";

import { useState } from "react";
import { PrepEntry, PrepLinks, PrepResult } from "@/lib/types";
import { to12h } from "@/lib/match";

function statusClass(status?: string): string {
  if (!status) return "st-neutral";
  const s = status.toLowerCase();
  if (s.includes("pass") || s.includes("lost")) return "st-red";
  if (s.includes("watch")) return "st-orange";
  if (s.includes("termsheet") || s.includes("term sheet") || s.includes("closing") || s.includes("closed"))
    return "st-blue";
  if (s.includes("new") || s.includes("screen") || s.includes("deep dive") || s.includes("diligence"))
    return "st-green";
  return "st-neutral";
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

// The only moves you make from a prep screen: keep the current status, or bump it
// forward. Exact Attio titles (a wrong title fails the write).
const FORWARD_STATUSES = ["1st Screen", "Deep Dive", "Diligence"];

/** Editable pipeline status — writes the change back to Attio on select. */
function StatusSelect({ entryId, status }: { entryId: string; status: string }) {
  const [value, setValue] = useState(status);
  const [state, setState] = useState<"idle" | "saving" | "saved" | "error">("idle");

  async function change(next: string) {
    if (next === value) return;
    const prev = value;
    setValue(next);
    setState("saving");
    try {
      const res = await fetch("/api/update-status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entryId, status: next }),
      });
      const j = await res.json();
      if (!j.ok) throw new Error();
      setState("saved");
      setTimeout(() => setState("idle"), 1500);
    } catch {
      setValue(prev); // revert on failure
      setState("error");
      setTimeout(() => setState("idle"), 2500);
    }
  }

  // Current status (whatever it is) + the three forward moves, deduped.
  const opts = value
    ? [value, ...FORWARD_STATUSES.filter((s) => s !== value)]
    : FORWARD_STATUSES;
  return (
    <span className="status-edit">
      <select
        className={`pill status-select ${statusClass(value)}`}
        value={value}
        onChange={(e) => change(e.target.value)}
        disabled={state === "saving"}
        title="Change pipeline status — writes to Attio"
      >
        {!value && <option value="">— set status —</option>}
        {opts.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
      {state === "saving" && <span className="save-ind">saving…</span>}
      {state === "saved" && <span className="save-ind ok">✓ saved</span>}
      {state === "error" && <span className="save-ind err">! failed</span>}
    </span>
  );
}

function PrepCard({ m }: { m: PrepEntry }) {
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
          {m.dealFlowEntryId ? (
            <StatusSelect entryId={m.dealFlowEntryId} status={m.status || ""} />
          ) : (
            m.status && <span className={`pill ${statusClass(m.status)}`}>{m.status}</span>
          )}
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

      {!loading &&
        data &&
        data.days.map((day) => (
          <div className="prep-day" key={day.date}>
            <div className="prep-day-head">{fmtDate(day.date)}</div>
            {day.meetings.length === 0 ? (
              <div className="prep-day-empty">No external meetings.</div>
            ) : (
              day.meetings.map((m, i) => <PrepCard m={m} key={i} />)
            )}
          </div>
        ))}
    </div>
  );
}
