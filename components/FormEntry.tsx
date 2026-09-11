"use client";

import { useEffect, useRef, useState } from "react";
import {
  FormDraftResponse,
  FormEntryList,
  FormEntryListItem,
  FormEntryMeeting,
  FormField,
} from "@/lib/types";
import { to12h } from "@/lib/match";

function fmtDate(d: string): string {
  const dt = new Date(d + "T00:00:00");
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diff = Math.round((dt.getTime() - today.getTime()) / 864e5);
  const label = dt.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
  const prefix = diff === 0 ? "Today · " : diff === -1 ? "Yesterday · " : "";
  return prefix + label;
}

const keyOf = (m: FormEntryListItem) => `${m.date}|${m.time || ""}|${m.title}`;

// Readonly factual field: URL → link, text → plain, empty → flagged blank.
function ReadonlyValue({ f }: { f: FormField }) {
  if (!f.value) return <span className="fe-blank">— blank · {f.blankReason}</span>;
  if (/^https?:\/\//.test(f.value)) {
    return (
      <a href={f.value} target="_blank" rel="noreferrer" className="fe-link">
        {f.value}
      </a>
    );
  }
  return <span className="fe-val">{f.value}</span>;
}

/** Compose the final pre-fill URL: server base + the interactive selections. */
function composeUrl(base: string, rec: string, tags: string[], notes: string): string {
  const extra = new URLSearchParams();
  if (rec) extra.append("prefill_Recommendation", rec);
  if (tags.length) extra.append("prefill_Tags", tags.join(",")); // multi-select = comma-joined
  // Airtable prefill keeps line breaks (each becomes a paragraph) but ignores
  // markdown — so we preserve the bullet lines verbatim, drop empty ones.
  const n = notes
    .split("\n")
    .map((s) => s.replace(/\s+$/, ""))
    .filter((s) => s.trim())
    .join("\n");
  if (n) extra.append("prefill_Other Notes / Analysis", n);
  const q = extra.toString();
  return q ? `${base}&${q}` : base;
}

function DraftCard({ m }: { m: FormEntryMeeting }) {
  const notesField = m.fields.find((f) => f.control === "longtext");
  const [rec, setRec] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [notes, setNotes] = useState(notesField?.value || "");
  const notesRef = useRef<HTMLTextAreaElement>(null);
  const caretRef = useRef<number | null>(null);

  // After a bullet edit re-renders the value, restore the caret position.
  useEffect(() => {
    if (caretRef.current != null && notesRef.current) {
      notesRef.current.selectionStart = notesRef.current.selectionEnd = caretRef.current;
      caretRef.current = null;
    }
  }, [notes]);

  // Enter continues the "- " bullet; Enter on an empty bullet drops out of the list.
  function onNotesKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key !== "Enter" || e.shiftKey) return;
    const ta = e.currentTarget;
    const { selectionStart, selectionEnd, value } = ta;
    const lineStart = value.lastIndexOf("\n", selectionStart - 1) + 1;
    const line = value.slice(lineStart, selectionStart);
    const bullet = line.match(/^(\s*)([-•*])\s+/);
    if (!bullet) return; // not in a bullet — normal newline
    e.preventDefault();
    if (line.slice(bullet[0].length).trim() === "") {
      // empty bullet → remove the marker and exit the list
      const next = value.slice(0, lineStart) + value.slice(selectionEnd);
      caretRef.current = lineStart;
      setNotes(next);
      return;
    }
    const insert = `\n${bullet[1]}- `;
    const next = value.slice(0, selectionStart) + insert + value.slice(selectionEnd);
    caretRef.current = selectionStart + insert.length;
    setNotes(next);
  }

  const toggleTag = (t: string) =>
    setTags((prev) => (prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t]));

  const url = composeUrl(m.prefillUrl, rec, tags, notes);

  return (
    <div className="fe-draft">
      <a href={url} target="_blank" rel="noreferrer" className="fe-open">
        Open pre-filled form ↗
      </a>
      <dl className="fe-fields">
        {m.fields.map((f) => (
          <div className="fe-row" key={f.label}>
            <dt>{f.label}</dt>
            <dd>
              {f.control === "select" ? (
                <select className="fe-select" value={rec} onChange={(e) => setRec(e.target.value)}>
                  <option value="">— choose —</option>
                  {(f.options || []).map((o) => (
                    <option key={o} value={o}>
                      {o.trim()}
                    </option>
                  ))}
                </select>
              ) : f.control === "multiselect" ? (
                <div className="fe-checks">
                  {(f.options || []).map((o) => (
                    <label key={o} className={`fe-check ${tags.includes(o) ? "on" : ""}`}>
                      <input type="checkbox" checked={tags.includes(o)} onChange={() => toggleTag(o)} />
                      {o.trim()}
                    </label>
                  ))}
                </div>
              ) : f.control === "longtext" ? (
                <textarea
                  ref={notesRef}
                  className="fe-textarea"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  onKeyDown={onNotesKeyDown}
                  rows={Math.max(3, notes.split("\n").length)}
                  placeholder="- a few bullets from the call…"
                />
              ) : (
                <ReadonlyValue f={f} />
              )}
            </dd>
          </div>
        ))}
      </dl>
      {notesField?.value && (
        <div className="fe-hint">
          Seeded from Grain&apos;s call summary. Enter starts a new bullet; line breaks carry into
          Airtable. Edit before submitting.
        </div>
      )}
    </div>
  );
}

const labelOf = (m: FormEntryListItem) =>
  [m.person, m.company].filter(Boolean).join(" · ") || m.company || m.person || m.term;

function MeetingRow({ m, onDismiss }: { m: FormEntryListItem; onDismiss: () => void }) {
  const [draft, setDraft] = useState<FormDraftResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function runDraft() {
    setLoading(true);
    setErr(null);
    try {
      const res = await fetch("/api/form-entry/draft", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          date: m.date,
          time: m.time,
          title: m.title,
          term: m.term,
          attendees: m.attendees,
        }),
      });
      const j: FormDraftResponse = await res.json();
      setDraft(j);
      setOpen(true);
    } catch {
      setErr("Draft failed — try again.");
    } finally {
      setLoading(false);
    }
  }

  const who = m.attendees.map((a) => a.name || a.email).filter(Boolean).join(", ");
  const label = labelOf(m);

  return (
    <div className="fe-card">
      <div className="fe-head">
        <div>
          <h3>{label}</h3>
          <div className="fe-when">
            {fmtDate(m.date)}
            {m.time ? ` · ${to12h(m.time)}` : ""} · {m.title}
          </div>
          {who && <div className="fe-attendees">{who}</div>}
        </div>
        <div className="fe-actions">
          {!draft ? (
            <button className="fe-open" onClick={runDraft} disabled={loading}>
              {loading ? "Drafting…" : "Draft form"}
            </button>
          ) : (
            <button className="fe-toggle" onClick={() => setOpen((o) => !o)}>
              {open ? "Hide draft" : "Show draft"}
            </button>
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

      {err && <div className="fe-warn">{err}</div>}

      {/* keep the draft mounted (state persists) and toggle visibility */}
      {draft && (
        <div hidden={!open}>
          {draft.note && <div className="fe-warn">{draft.note}</div>}
          {draft.resolved && draft.meeting ? (
            <DraftCard m={draft.meeting} />
          ) : (
            !draft.note && <div className="fe-warn">Couldn&apos;t draft this meeting.</div>
          )}
        </div>
      )}
    </div>
  );
}

function fmtUpdated(iso?: string): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return d >= today
    ? `Updated ${time}`
    : `Updated ${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })}, ${time}`;
}

export default function FormEntry({
  data,
  loading,
  onRefresh,
  onClose,
}: {
  data: FormEntryList | null;
  loading: boolean;
  onRefresh: () => void;
  onClose: () => void;
}) {
  const updated = fmtUpdated(data?.generatedAt);
  // Optimistic override of each row's persisted "dismissed" flag (✕ / Restore).
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});
  const isRemoved = (m: FormEntryListItem) => overrides[m.key] ?? !!m.dismissed;

  async function setDismiss(m: FormEntryListItem, dismissed: boolean) {
    setOverrides((prev) => ({ ...prev, [m.key]: dismissed }));
    try {
      await fetch("/api/form-entry/dismiss", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: m.key, undo: !dismissed }),
      });
    } catch {
      /* optimistic; the store write is best-effort */
    }
  }

  const all = data?.meetings ?? [];
  const active = all.filter((m) => !isRemoved(m));
  const removed = all.filter((m) => isRemoved(m));

  const byDay = new Map<string, FormEntryListItem[]>();
  for (const m of active) {
    if (!byDay.has(m.date)) byDay.set(m.date, []);
    byDay.get(m.date)!.push(m);
  }

  return (
    <div className="prep">
      <div className="prep-head">
        <div className="prep-title">
          <h2>Form Entry · last 5 days</h2>
          {updated && <span className="prep-updated">{updated}</span>}
        </div>
        <div className="prep-actions">
          <button className="prep-back" onClick={onRefresh} disabled={loading} title="Re-scan recent meetings">
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
          <span>Loading your recent meetings…</span>
        </div>
      )}

      {!loading && data && !data.configured && (
        <div className="empty-note">Google Calendar isn&apos;t connected.</div>
      )}

      {!loading && data && data.configured && all.length === 0 && (
        <div className="empty-note">No external meetings in the last 5 days.</div>
      )}

      {!loading && data && data.configured && all.length > 0 && active.length === 0 && (
        <div className="empty-note">All caught up — no forms left to submit.</div>
      )}

      {!loading &&
        data &&
        [...byDay.entries()].map(([date, meetings]) => (
          <div className="prep-day" key={date}>
            <div className="prep-day-head">{fmtDate(date)}</div>
            {meetings.map((m) => (
              <MeetingRow m={m} key={keyOf(m)} onDismiss={() => setDismiss(m, true)} />
            ))}
          </div>
        ))}

      {!loading && removed.length > 0 && (
        <div className="prep-day fe-removed-section">
          <div className="prep-day-head">Dismissed · {removed.length}</div>
          {removed.map((m) => (
            <div className="fe-removed-row" key={keyOf(m)}>
              <div className="fe-removed-info">
                <span className="fe-removed-label">{labelOf(m)}</span>
                <span className="fe-removed-when">
                  {fmtDate(m.date)}
                  {m.time ? ` · ${to12h(m.time)}` : ""}
                </span>
              </div>
              <button className="fe-undo" onClick={() => setDismiss(m, false)} type="button">
                Restore
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
