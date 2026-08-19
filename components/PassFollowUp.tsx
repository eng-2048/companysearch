"use client";

import { useState } from "react";
import {
  PassFollowUpList,
  PassItem,
  PassEmailDraft,
  PassDraftResponse,
  PassSendResponse,
} from "@/lib/types";

const REASONS = ["Market size", "Competitive landscape", "Round dynamics", "Generic"];

// Statuses reachable from this screen (current + the moves you'd make here).
const PFU_STATUSES = ["Pass", "To Pass", "Watch", "Still Thinking"];

function statusClass(status?: string): string {
  if (!status) return "st-neutral";
  const s = status.toLowerCase();
  if (s.includes("pass") || s.includes("lost")) return "st-red";
  if (s.includes("watch")) return "st-orange";
  if (s.includes("termsheet") || s.includes("closing") || s.includes("closed")) return "st-blue";
  if (s.includes("new") || s.includes("screen") || s.includes("deep dive") || s.includes("diligence"))
    return "st-green";
  return "st-neutral";
}

/** Editable pipeline status — writes to Attio on select. Calls onPassed when the
 *  deal is moved to "Pass" so the parent can drop the card. */
function StatusSelect({
  entryId,
  status,
  onChanged,
}: {
  entryId: string;
  status: string;
  onChanged?: (next: string) => void;
}) {
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
      onChanged?.(next);
    } catch {
      setValue(prev);
      setState("error");
      setTimeout(() => setState("idle"), 2500);
    }
  }

  const opts = value ? [value, ...PFU_STATUSES.filter((s) => s !== value)] : PFU_STATUSES;
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

type AddrList = { name?: string; email: string }[];

const parseCc = (s: string): AddrList =>
  s
    .split(/[,;\s]+/)
    .map((e) => e.trim())
    .filter((e) => e.includes("@"))
    .map((email) => ({ email }));

/** One email composer — used for both the pass email and the close-the-loop email.
 *  Generates a draft on demand, then everything (recipient, cc, subject, body) is
 *  editable before an explicit Send. */
function EmailComposer({
  item,
  kind,
  testRecipient,
  onSent,
}: {
  item: PassItem;
  kind: "pass" | "close";
  testRecipient: string;
  onSent?: () => void;
}) {
  const [reasons, setReasons] = useState<string[]>([]);
  const [mode, setMode] = useState<"fresh" | "reply">(kind === "close" ? "reply" : "fresh");
  const [instructions, setInstructions] = useState("");
  const [loading, setLoading] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const [draft, setDraft] = useState<PassEmailDraft | null>(null);
  // editable fields (initialized from the draft, then user-owned)
  const [toName, setToName] = useState("");
  const [toEmail, setToEmail] = useState("");
  const [cc, setCc] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");

  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState<PassSendResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const toggleReason = (r: string) =>
    setReasons((cur) => (cur.includes(r) ? cur.filter((x) => x !== r) : [...cur, r]));

  async function generate() {
    setLoading(true);
    setError(null);
    setSent(null);
    try {
      const res = await fetch("/api/pass-follow-up/draft", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind,
          // recent rows carry a meeting (better Grain match); To Pass rows use the record
          recordId: item.meeting ? undefined : item.recordId,
          meeting: item.meeting,
          reasons,
          mode,
          customInstructions: instructions || undefined,
        }),
      });
      const j: PassDraftResponse = await res.json();
      setNote(j.note || null);
      if (j.ok && j.draft) {
        setDraft(j.draft);
        setToName(j.draft.to[0]?.name || "");
        setToEmail(j.draft.to[0]?.email || "");
        setSubject(j.draft.subject);
        setBody(j.draft.body);
        setMode(j.draft.mode);
      } else {
        setDraft(null);
        setError(j.note || "Couldn't draft this email.");
      }
    } catch {
      setError("Draft request failed.");
    } finally {
      setLoading(false);
    }
  }

  async function send() {
    if (!toEmail.includes("@")) {
      setError("Add a valid recipient email first.");
      return;
    }
    const ok = window.confirm(
      `Send this ${kind === "pass" ? "pass" : "close-the-loop"} email?\n\n` +
        `TEST MODE: it will actually go to ${testRecipient} (not ${toEmail}).` +
        (kind === "pass" && item.dealFlowEntryId ? `\n\nThe deal will be marked "Pass" in Attio.` : "")
    );
    if (!ok) return;

    setSending(true);
    setError(null);
    try {
      const res = await fetch("/api/pass-follow-up/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind,
          to: [{ name: toName || undefined, email: toEmail }],
          cc: parseCc(cc),
          subject,
          body,
          mode,
          threadId: draft?.threadId,
          inReplyTo: draft?.inReplyTo,
          references: draft?.references,
          dealFlowEntryId: item.dealFlowEntryId,
          flipStatus: kind === "pass",
        }),
      });
      const j: PassSendResponse = await res.json();
      if (j.ok && j.sent) {
        setSent(j);
        if (kind === "pass" && j.statusFlipped) onSent?.();
      } else {
        setError(j.error || "Send failed.");
      }
    } catch {
      setError("Send request failed.");
    } finally {
      setSending(false);
    }
  }

  const unverified = kind === "pass" && !item.recipient.verified;
  const candidates = item.recipient.candidates || [];

  return (
    <div className={`composer ${kind}`}>
      <div className="cmp-controls">
        <div className="cmp-reasons">
          <span className="cmp-label">Reason for pass</span>
          <div className="cmp-checks">
            {REASONS.map((r) => (
              <label key={r} className={`fe-check ${reasons.includes(r) ? "on" : ""}`}>
                <input type="checkbox" checked={reasons.includes(r)} onChange={() => toggleReason(r)} />
                {r}
              </label>
            ))}
          </div>
        </div>
        <div className="cmp-mode">
          <span className="cmp-label">Style</span>
          <div className="cmp-seg">
            <button className={mode === "fresh" ? "on" : ""} onClick={() => setMode("fresh")} type="button">
              Fresh email
            </button>
            <button className={mode === "reply" ? "on" : ""} onClick={() => setMode("reply")} type="button">
              Reply in thread
            </button>
          </div>
        </div>
      </div>

      <textarea
        className="fe-textarea cmp-instr"
        placeholder={
          kind === "pass"
            ? "Custom instructions (optional) — anything else the pass email should say or avoid…"
            : "Custom instructions (optional) — anything else to tell the introducer…"
        }
        value={instructions}
        onChange={(e) => setInstructions(e.target.value)}
        rows={2}
      />

      <button className="cmp-gen" onClick={generate} disabled={loading} type="button">
        {loading ? "Drafting…" : draft ? "↻ Regenerate" : "Draft email"}
      </button>

      {note && !error && <div className="cmp-note">{note}</div>}
      {error && <div className="error-box">⚠ {error}</div>}

      {draft && (
        <div className="cmp-draft">
          {unverified && (
            <div className="cmp-warn">
              ⚠ Recipient not confirmed from Attio — check the name and email before sending.
            </div>
          )}

          <div className="cmp-field">
            <label>To</label>
            <div className="cmp-to">
              <input
                className="cmp-input name"
                value={toName}
                onChange={(e) => setToName(e.target.value)}
                placeholder="Name"
              />
              <input
                className="cmp-input email"
                value={toEmail}
                onChange={(e) => setToEmail(e.target.value)}
                placeholder="email@company.com"
              />
            </div>
          </div>

          {candidates.length > 1 && (
            <div className="cmp-cands">
              <span>Or pick: </span>
              {candidates.map((c) => (
                <button
                  key={c.email}
                  type="button"
                  className="cmp-cand"
                  onClick={() => {
                    setToName(c.name);
                    setToEmail(c.email);
                  }}
                >
                  {c.name} &lt;{c.email}&gt;{c.role ? ` · ${c.role}` : ""}
                </button>
              ))}
            </div>
          )}

          <div className="cmp-field">
            <label>Cc</label>
            <input
              className="cmp-input"
              value={cc}
              onChange={(e) => setCc(e.target.value)}
              placeholder="Optional — comma-separated emails"
            />
          </div>

          <div className="cmp-field">
            <label>Subject</label>
            <input className="cmp-input" value={subject} onChange={(e) => setSubject(e.target.value)} />
          </div>

          <div className="cmp-field">
            <label>Body</label>
            <textarea
              className="fe-textarea cmp-body"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={14}
            />
          </div>

          {draft.grainUrl && (
            <a className="cmp-grain" href={draft.grainUrl} target="_blank" rel="noreferrer">
              Grain call ↗
            </a>
          )}

          <div className="cmp-send-row">
            <button className="cmp-send" onClick={send} disabled={sending || !!sent} type="button">
              {sending ? "Sending…" : sent ? "✓ Sent" : `Send test → ${testRecipient}`}
            </button>
            {sent && (
              <span className="cmp-sent">
                Sent to {sent.actualTo.join(", ")}
                {sent.testMode ? " (test mode)" : ""}
                {sent.statusFlipped ? " · marked Pass" : ""}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function PassCard({ item, testRecipient }: { item: PassItem; testRecipient: string }) {
  const [open, setOpen] = useState<"none" | "pass" | "close">("none");
  const [removed, setRemoved] = useState(false);

  if (removed) return null;

  const founderLine = item.founder && !item.company.includes(item.founder) ? ` · ${item.founder}` : "";

  return (
    <div className="pfu-card">
      <div className="pfu-head">
        <div className="pfu-title">
          <h3>
            {item.company}
            <span className="pfu-founder">{founderLine}</span>
          </h3>
          <div className="pfu-meta">
            {item.date && <span>{item.date}</span>}
            {item.introducer && (
              <span className="pfu-intro">
                intro: {item.introducer.name}
                {item.introducer.type ? ` (${item.introducer.type})` : ""}
              </span>
            )}
          </div>
        </div>
        <div className="pfu-status">
          {item.dealFlowEntryId ? (
            <StatusSelect
              entryId={item.dealFlowEntryId}
              status={item.status || ""}
              onChanged={(next) => {
                if (next.toLowerCase() === "pass") setRemoved(true);
              }}
            />
          ) : (
            item.status && <span className={`pill ${statusClass(item.status)}`}>{item.status}</span>
          )}
        </div>
      </div>

      {item.description && <div className="pfu-desc">{item.description}</div>}

      <div className="pfu-actions">
        <button
          className={`pfu-btn ${open === "pass" ? "on" : ""}`}
          onClick={() => setOpen(open === "pass" ? "none" : "pass")}
          type="button"
        >
          {open === "pass" ? "Hide pass email" : "Draft pass email"}
        </button>
        {item.closeLoopEligible && (
          <button
            className={`pfu-btn ghost ${open === "close" ? "on" : ""}`}
            onClick={() => setOpen(open === "close" ? "none" : "close")}
            type="button"
          >
            {open === "close" ? "Hide close-the-loop" : "Close the loop?"}
          </button>
        )}
        {item.attioUrl && (
          <a className="pfu-link" href={item.attioUrl} target="_blank" rel="noreferrer">
            Attio ↗
          </a>
        )}
      </div>

      {open === "pass" && (
        <EmailComposer item={item} kind="pass" testRecipient={testRecipient} onSent={() => setRemoved(true)} />
      )}
      {open === "close" && <EmailComposer item={item} kind="close" testRecipient={testRecipient} />}
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

export default function PassFollowUp({
  data,
  loading,
  onRefresh,
  onClose,
}: {
  data: PassFollowUpList | null;
  loading: boolean;
  onRefresh: () => void;
  onClose: () => void;
}) {
  const updated = fmtUpdated(data?.generatedAt);
  const testRecipient = data?.testRecipient || "zannali@gmail.com";

  return (
    <div className="prep pfu">
      <div className="prep-head">
        <div className="prep-title">
          <h2>Pass / Follow-Up</h2>
          {updated && <span className="prep-updated">{updated}</span>}
        </div>
        <div className="prep-actions">
          <button className="prep-back" onClick={onRefresh} disabled={loading} title="Re-scan now">
            {loading && data ? "Refreshing…" : "↻ Refresh"}
          </button>
          <button className="prep-back" onClick={onClose}>
            ← Search
          </button>
        </div>
      </div>

      {data?.testMode && (
        <div className="pfu-testbanner">
          🔒 Test mode — every email is sent to <strong>{testRecipient}</strong> (never the real
          recipient). Sending always requires your explicit confirmation.
        </div>
      )}

      {loading && !data && (
        <div className="status-line">
          <span className="spinner" />
          <span>Pulling To Pass deals and recent meetings…</span>
        </div>
      )}

      {!loading && data && !data.configured && (
        <div className="empty-note">Google Calendar isn&apos;t connected.</div>
      )}

      {data && (
        <>
          <div className="pfu-section">
            <div className="pfu-section-head">
              To Pass
              <span className="pfu-count">
                {data.toPassTotal && data.toPassTotal > data.toPass.length
                  ? `${data.toPass.length} of ${data.toPassTotal}`
                  : data.toPass.length}
              </span>
            </div>
            {data.toPass.length === 0 ? (
              <div className="pfu-empty">Nothing queued to pass.</div>
            ) : (
              data.toPass.map((it) => (
                <PassCard key={it.recordId} item={it} testRecipient={testRecipient} />
              ))
            )}
          </div>

          <div className="pfu-section">
            <div className="pfu-section-head">
              Recent meetings
              <span className="pfu-count">{data.recent.length}</span>
            </div>
            {data.recent.length === 0 ? (
              <div className="pfu-empty">No other recent meetings.</div>
            ) : (
              data.recent.map((it) => (
                <PassCard key={it.recordId} item={it} testRecipient={testRecipient} />
              ))
            )}
          </div>
        </>
      )}
    </div>
  );
}
