"use client";

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
          {m.status && <span className={`pill ${statusClass(m.status)}`}>{m.status}</span>}
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

export default function MeetingPrep({
  data,
  loading,
  onClose,
}: {
  data: PrepResult | null;
  loading: boolean;
  onClose: () => void;
}) {
  const totalMeetings = data?.days.reduce((n, d) => n + d.meetings.length, 0) ?? 0;

  return (
    <div className="prep">
      <div className="prep-head">
        <h2>Meeting prep · next 3 days</h2>
        <button className="prep-back" onClick={onClose}>
          ← Search
        </button>
      </div>

      {loading && (
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
