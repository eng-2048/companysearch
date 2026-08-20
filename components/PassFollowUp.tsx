"use client";

import { useEffect, useRef, useState } from "react";
import {
  PassFollowUpList,
  PassItem,
  PassEmailDraft,
  PassDraftResponse,
  PassSendResponse,
  PassThreadPreview,
  PriorOutreach,
} from "@/lib/types";
import StatusSelect, { statusClass } from "@/components/StatusSelect";

const REASONS = ["Market size", "Competitive landscape", "Round dynamics"];
const PFU_STATUSES = ["Pass", "To Pass", "Watch", "1st Screen", "Still Thinking"];

type Addr = { name?: string; email: string };
const parseCc = (s: string): Addr[] =>
  s.split(/[,;\s]+/).map((e) => e.trim()).filter((e) => e.includes("@")).map((email) => ({ email }));

function defaultFollowUp(): string {
  return new Date(Date.now() + 90 * 864e5).toISOString().slice(0, 10);
}

/** The email drafter — pass, watch, or close-the-loop. Shown full-screen (its own
 *  view), or embedded (close-the-loop) below the pass email. Supports multiple To
 *  recipients, a refine step, and a review-and-send step. */
function EmailComposer({
  item,
  kind,
  testRecipient,
  autoLoad,
  onSent,
}: {
  item: PassItem;
  kind: "pass" | "close" | "watch";
  testRecipient: string;
  autoLoad: boolean;
  onSent?: () => void;
}) {
  const [phase, setPhase] = useState<"compose" | "review">("compose");
  const [reasons, setReasons] = useState<string[]>([]);
  const [followUpDate, setFollowUpDate] = useState(defaultFollowUp());
  const [instructions, setInstructions] = useState("");
  const [loading, setLoading] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [prior, setPrior] = useState<PriorOutreach | null>(null);

  const [draft, setDraft] = useState<PassEmailDraft | null>(null);
  const [to, setTo] = useState<Addr[]>([]);
  const [cc, setCc] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");

  const [mode, setMode] = useState<"fresh" | "reply">(kind === "close" ? "reply" : "fresh");
  const [thread, setThread] = useState<PassThreadPreview | null>(null);
  const [threadLoading, setThreadLoading] = useState(false);

  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState<PassSendResponse | null>(null);

  const started = useRef(false);
  useEffect(() => {
    if (autoLoad && !started.current) {
      started.current = true;
      void generate();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggleReason = (r: string) =>
    setReasons((cur) => (cur.includes(r) ? cur.filter((x) => x !== r) : [...cur, r]));

  const validTo = () => to.filter((a) => a.email.includes("@"));

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
          recordId: item.meeting ? undefined : item.recordId,
          meeting: item.meeting,
          reasons,
          customInstructions: instructions || undefined,
        }),
      });
      const j: PassDraftResponse = await res.json();
      setNote(j.note || null);
      setPrior(j.priorOutreach || null);
      if (j.ok && j.draft) {
        setDraft(j.draft);
        setTo(j.draft.to.length ? j.draft.to : [{ email: "" }]);
        setSubject(j.draft.subject);
        setBody(j.draft.body);
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

  const setToField = (i: number, field: "name" | "email", val: string) =>
    setTo((prev) => prev.map((r, idx) => (idx === i ? { ...r, [field]: val } : r)));
  const addToRow = () => setTo((prev) => [...prev, { email: "" }]);
  const removeToRow = (i: number) => setTo((prev) => prev.filter((_, idx) => idx !== i));
  const addCandidate = (c: Addr) =>
    setTo((prev) =>
      prev.some((r) => r.email.toLowerCase() === c.email.toLowerCase())
        ? prev
        : [...prev.filter((r) => r.email.trim()), { name: c.name, email: c.email }]
    );

  async function loadThread() {
    setThreadLoading(true);
    try {
      const emails = [...validTo().map((a) => a.email), ...(item.recipient.candidates || []).map((c) => c.email)]
        .filter(Boolean)
        .join(",");
      const res = await fetch(`/api/pass-follow-up/thread?emails=${encodeURIComponent(emails)}`);
      setThread(await res.json());
    } catch {
      setThread({ found: false, messages: [] });
    } finally {
      setThreadLoading(false);
    }
  }

  function goReview() {
    if (validTo().length === 0) {
      setError("Add a valid recipient email first.");
      return;
    }
    setError(null);
    setPhase("review");
    if (mode === "reply" && !thread) void loadThread();
  }

  function chooseMode(next: "fresh" | "reply") {
    setMode(next);
    if (next === "reply" && !thread) void loadThread();
  }

  const replying = mode === "reply" && thread?.found;
  const effectiveSubject = replying ? thread!.subject || subject : subject;

  async function send() {
    const recipients = validTo();
    if (recipients.length === 0) {
      setError("Add a valid recipient email first.");
      return;
    }
    const label = kind === "pass" ? "pass" : kind === "watch" ? "keep-in-touch" : "close-the-loop";
    const afterEffect =
      kind === "pass" && item.dealFlowEntryId
        ? `\n\nThe deal will be marked "Pass" in Attio.`
        : kind === "watch" && item.dealFlowEntryId
          ? `\n\nThe deal will be marked "Watch" with a follow-up date of ${followUpDate}.`
          : "";
    const priorWarn = prior
      ? `⚠ A ${prior.kind === "outreach" ? "prior" : prior.kind} email was already sent to this founder by ${prior.who} on ${prior.date} ("${prior.subject}").\n\n`
      : "";
    const ok = window.confirm(
      priorWarn +
        `Send this ${label} email to ${recipients.map((r) => r.email).join(", ")}?\n\n` +
        `TEST MODE: it will actually go to ${testRecipient}.` +
        afterEffect
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
          to: recipients.map((a) => ({ name: a.name || undefined, email: a.email })),
          cc: parseCc(cc),
          subject: effectiveSubject,
          body,
          mode,
          threadId: replying ? thread!.threadId : undefined,
          inReplyTo: replying ? thread!.inReplyTo : undefined,
          references: replying ? thread!.references : undefined,
          dealFlowEntryId: item.dealFlowEntryId,
          flipStatus: kind === "pass",
          followUpDate: kind === "watch" ? followUpDate : undefined,
        }),
      });
      const j: PassSendResponse = await res.json();
      if (j.ok && j.sent) {
        setSent(j);
        if ((kind === "pass" || kind === "watch") && j.statusFlipped) onSent?.();
      } else {
        setError(j.error || "Send failed.");
      }
    } catch {
      setError("Send request failed.");
    } finally {
      setSending(false);
    }
  }

  const unverified = (kind === "pass" || kind === "watch") && !item.recipient.verified;
  const candidates = item.recipient.candidates || [];
  const priorBanner = prior ? (
    <div className="cmp-prior">
      ⚠{" "}
      {prior.kind === "pass" ? "A pass email" : prior.kind === "watch" ? "A watch email" : "An email"} was
      already sent to this founder by <strong>{prior.who}</strong>
      {prior.date ? ` on ${prior.date}` : ""}
      {prior.subject ? ` — “${prior.subject}”` : ""}. Double-check before sending.
    </div>
  ) : null;

  // close-the-loop: on-demand first draft
  if (!autoLoad && !draft && !loading) {
    return (
      <div className={`composer ${kind}`}>
        {error && <div className="error-box">⚠ {error}</div>}
        <button className="cmp-gen" onClick={generate} type="button">
          Draft close-the-loop email
        </button>
      </div>
    );
  }
  if (loading && !draft) {
    return (
      <div className={`composer ${kind}`}>
        <div className="status-line">
          <span className="spinner" />
          <span>Drafting…</span>
        </div>
      </div>
    );
  }
  if (!draft) {
    return <div className={`composer ${kind}`}>{error && <div className="error-box">⚠ {error}</div>}</div>;
  }

  // ————— review phase —————
  if (phase === "review") {
    return (
      <div className={`composer ${kind}`}>
        <div className="cmp-review-head">
          <button className="cmp-back" onClick={() => setPhase("compose")} type="button">
            ← Back to edit
          </button>
          <span className="cmp-review-title">Review &amp; send</span>
        </div>
        {priorBanner}
        <div className="cmp-delivery">
          <span className="cmp-label">Delivery</span>
          <div className="cmp-seg">
            <button className={mode === "fresh" ? "on" : ""} onClick={() => chooseMode("fresh")} type="button">
              Fresh email
            </button>
            <button className={mode === "reply" ? "on" : ""} onClick={() => chooseMode("reply")} type="button">
              Reply in thread
            </button>
          </div>
        </div>
        {mode === "reply" && (
          <div className="cmp-thread">
            {threadLoading ? (
              <div className="status-line">
                <span className="spinner" />
                <span>Finding the thread…</span>
              </div>
            ) : thread?.found ? (
              <>
                <div className="cmp-thread-head">
                  Replying on: <strong>{thread.subject}</strong>
                </div>
                {thread.messages.map((m, i) => (
                  <div className="cmp-thread-msg" key={i}>
                    <div className="cmp-tm-top">
                      <span className="cmp-tm-who">{m.who}</span>
                      <span className="cmp-tm-date">{m.date}</span>
                    </div>
                    <div className="cmp-tm-snip">{m.snippet}</div>
                  </div>
                ))}
              </>
            ) : (
              <div className="cmp-note">No prior thread found — this will send as a fresh email.</div>
            )}
          </div>
        )}
        <div className="cmp-summary">
          <div className="cmp-srow">
            <span>To</span>
            <span>{validTo().map((a) => `${a.name ? a.name + " " : ""}<${a.email}>`).join(", ")}</span>
          </div>
          {parseCc(cc).length > 0 && (
            <div className="cmp-srow">
              <span>Cc</span>
              <span>{parseCc(cc).map((a) => a.email).join(", ")}</span>
            </div>
          )}
          <div className="cmp-srow">
            <span>Subject</span>
            <span>{effectiveSubject}</span>
          </div>
        </div>
        <pre className="cmp-preview">{body}</pre>
        {error && <div className="error-box">⚠ {error}</div>}
        <div className="cmp-send-row">
          <button className="cmp-send" onClick={send} disabled={sending || !!sent} type="button">
            {sending ? "Sending…" : sent ? "✓ Sent" : `Send test → ${testRecipient}`}
          </button>
          {sent && (
            <span className="cmp-sent">
              Sent to {sent.actualTo.join(", ")}
              {sent.testMode ? " (test mode)" : ""}
              {sent.statusFlipped ? " · status updated" : ""}
            </span>
          )}
        </div>
      </div>
    );
  }

  // ————— compose phase: draft on top, refine below —————
  return (
    <div className={`composer ${kind}`}>
      {priorBanner}
      {unverified && (
        <div className="cmp-warn">
          ⚠ Recipient not confirmed from Attio — check the name and email before sending.
        </div>
      )}
      {note && !error && <div className="cmp-note">{note}</div>}
      {error && <div className="error-box">⚠ {error}</div>}

      <div className="cmp-field">
        <label>To</label>
        {to.map((r, i) => (
          <div className="cmp-to" key={i}>
            <input
              className="cmp-input name"
              value={r.name || ""}
              onChange={(e) => setToField(i, "name", e.target.value)}
              placeholder="Name"
            />
            <input
              className="cmp-input email"
              value={r.email}
              onChange={(e) => setToField(i, "email", e.target.value)}
              placeholder="email@company.com"
            />
            {to.length > 1 && (
              <button className="cmp-to-x" onClick={() => removeToRow(i)} type="button" title="Remove recipient">
                ✕
              </button>
            )}
          </div>
        ))}
        <button className="cmp-add-to" onClick={addToRow} type="button">
          + Add recipient
        </button>
      </div>

      {candidates.length > 0 && (
        <div className="cmp-cands">
          <span>Add from Attio: </span>
          {candidates.map((c) => (
            <button
              key={c.email}
              type="button"
              className="cmp-cand"
              disabled={to.some((r) => r.email.toLowerCase() === c.email.toLowerCase())}
              onClick={() => addCandidate(c)}
            >
              + {c.name} &lt;{c.email}&gt;{c.role ? ` · ${c.role}` : ""}
            </button>
          ))}
        </div>
      )}

      <div className="cmp-field">
        <label>Cc</label>
        <input className="cmp-input" value={cc} onChange={(e) => setCc(e.target.value)} placeholder="Optional — comma-separated emails" />
      </div>

      <div className="cmp-field">
        <label>Subject</label>
        <input className="cmp-input" value={subject} onChange={(e) => setSubject(e.target.value)} />
      </div>

      <div className="cmp-field">
        <label>Body</label>
        <textarea className="fe-textarea cmp-body" value={body} onChange={(e) => setBody(e.target.value)} rows={14} />
      </div>

      {draft.grainUrl && (
        <a className="cmp-grain" href={draft.grainUrl} target="_blank" rel="noreferrer">
          Grain call ↗
        </a>
      )}

      {kind === "watch" && (
        <div className="cmp-field cmp-followup">
          <label>Follow-up date (written to Attio on send)</label>
          <input type="date" className="cmp-input" value={followUpDate} onChange={(e) => setFollowUpDate(e.target.value)} />
        </div>
      )}

      <div className="cmp-refine">
        <span className="cmp-label">Refine this draft</span>
        {kind === "pass" && (
          <div className="cmp-checks">
            {REASONS.map((r) => (
              <label key={r} className={`fe-check ${reasons.includes(r) ? "on" : ""}`}>
                <input type="checkbox" checked={reasons.includes(r)} onChange={() => toggleReason(r)} />
                {r}
              </label>
            ))}
          </div>
        )}
        <textarea
          className="fe-textarea cmp-instr"
          placeholder={
            kind === "pass"
              ? "Custom instructions (optional) — e.g. mention we loved the demo, keep it short, add a specific reason…"
              : kind === "watch"
                ? "Custom instructions (optional) — e.g. reference a milestone to check in on, keep it warm…"
                : "Custom instructions (optional) — anything else to tell the introducer…"
          }
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
          rows={2}
        />
        <button className="cmp-gen" onClick={generate} disabled={loading} type="button">
          {loading ? "Redrafting…" : "↻ Regenerate with these"}
        </button>
      </div>

      <div className="cmp-send-row">
        <button className="cmp-review-btn" onClick={goReview} type="button">
          Review &amp; send →
        </button>
      </div>
    </div>
  );
}

/** Full-screen drafter for one deal + kind (pass or watch), with the close-the-loop
 *  email below when it's a pass and there's a person to close the loop with. */
function DraftScreen({
  item,
  kind,
  testRecipient,
  onBack,
  onSent,
}: {
  item: PassItem;
  kind: "pass" | "watch";
  testRecipient: string;
  onBack: () => void;
  onSent: () => void;
}) {
  const founderLine = item.founder && !item.company.includes(item.founder) ? ` · ${item.founder}` : "";
  return (
    <div className="pfu-ds">
      <div className="prep-head">
        <div className="prep-title">
          <h2>
            {kind === "pass" ? "Pass" : "Watch"} · {item.company}
            <span className="pfu-founder">{founderLine}</span>
          </h2>
        </div>
        <button className="prep-back" onClick={onBack} type="button">
          ← Back to list
        </button>
      </div>

      <div className="pfu-ds-intro">
        {item.introText ? (
          <>
            Intro&rsquo;d by <strong>{item.introText}</strong>.{" "}
            {item.closeLoopEligible ? (
              <span className="pfu-owe">You owe a close-the-loop email — draft it below.</span>
            ) : (
              <span className="pfu-noloop">No close-the-loop needed (channel intro).</span>
            )}
          </>
        ) : (
          <span className="pfu-noloop">No intro on file — no close-the-loop needed.</span>
        )}
      </div>

      <EmailComposer item={item} kind={kind} testRecipient={testRecipient} autoLoad onSent={onSent} />

      {kind === "pass" && item.closeLoopEligible && (
        <div className="pfu-cl">
          <div className="pfu-cl-head">
            Close the loop
            {item.introducer && (
              <span className="pfu-cl-sub">
                with {item.introducer.name}
                {item.introducer.type ? ` (${item.introducer.type})` : ""}
              </span>
            )}
          </div>
          <EmailComposer item={item} kind="close" testRecipient={testRecipient} autoLoad={false} />
        </div>
      )}
    </div>
  );
}

function PassCard({
  item,
  onDraft,
  onDismiss,
}: {
  item: PassItem;
  onDraft: (kind: "pass" | "watch") => void;
  onDismiss: () => void;
}) {
  const founderLine = item.founder && !item.company.includes(item.founder) ? ` · ${item.founder}` : "";
  return (
    <div className="pfu-card">
      <button className="pfu-x-bubble" onClick={onDismiss} type="button" title="No email needed — remove">
        ✕
      </button>
      <div className="pfu-head">
        <div className="pfu-title">
          <h3>
            {item.company}
            <span className="pfu-founder">{founderLine}</span>
          </h3>
          <div className="pfu-meta">
            {item.date && <span>{item.date}</span>}
            {item.introText && (
              <span className={`pfu-intro ${item.closeLoopEligible ? "owe" : ""}`}>
                intro: {item.introText}
                {item.closeLoopEligible ? " · close the loop" : ""}
              </span>
            )}
          </div>
        </div>
        <div className="pfu-status">
          {item.dealFlowEntryId ? (
            <StatusSelect entryId={item.dealFlowEntryId} status={item.status || ""} forwardStatuses={PFU_STATUSES} />
          ) : (
            item.status && <span className={`pill ${statusClass(item.status)}`}>{item.status}</span>
          )}
        </div>
      </div>

      {item.description && <div className="pfu-desc">{item.description}</div>}

      <div className="pfu-actions">
        <button className="pfu-btn" onClick={() => onDraft("pass")} type="button">
          Pass
        </button>
        <button className="pfu-btn ghost" onClick={() => onDraft("watch")} type="button">
          Watch
        </button>
        {item.attioUrl && (
          <a className="pfu-link" href={item.attioUrl} target="_blank" rel="noreferrer">
            Attio ↗
          </a>
        )}
      </div>
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
  const [drafting, setDrafting] = useState<{ item: PassItem; kind: "pass" | "watch" } | null>(null);
  const [removed, setRemoved] = useState<Set<string>>(new Set());
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());

  const updated = fmtUpdated(data?.generatedAt);
  const testRecipient = data?.testRecipient || "zannali@gmail.com";

  const drop = (setter: typeof setRemoved, id: string) =>
    setter((prev) => new Set(prev).add(id));
  const undrop = (setter: typeof setRemoved, id: string) =>
    setter((prev) => {
      const n = new Set(prev);
      n.delete(id);
      return n;
    });

  async function dismiss(item: PassItem, undo = false) {
    if (undo) undrop(setDismissed, item.recordId);
    else drop(setDismissed, item.recordId);
    try {
      await fetch("/api/pass-follow-up/dismiss", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: item.recordId, undo }),
      });
    } catch {
      /* optimistic */
    }
  }

  if (drafting) {
    return (
      <div className="prep pfu">
        <DraftScreen
          item={drafting.item}
          kind={drafting.kind}
          testRecipient={testRecipient}
          onBack={() => setDrafting(null)}
          onSent={() => drop(setRemoved, drafting.item.recordId)}
        />
      </div>
    );
  }

  const visible = (arr: PassItem[]) => arr.filter((i) => !removed.has(i.recordId));

  const renderItem = (it: PassItem) =>
    dismissed.has(it.recordId) ? (
      <div className="fe-dismissed" key={it.recordId}>
        <span>“{it.company}” — no email needed.</span>
        <button className="fe-undo" onClick={() => dismiss(it, true)} type="button">
          Undo
        </button>
      </div>
    ) : (
      <PassCard
        key={it.recordId}
        item={it}
        onDraft={(kind) => setDrafting({ item: it, kind })}
        onDismiss={() => dismiss(it)}
      />
    );

  const toPass = data ? visible(data.toPass) : [];
  const recent = data ? visible(data.recent) : [];

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
          <span>Pulling your To Pass deals and recent meetings…</span>
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
                  ? `${toPass.length} of ${data.toPassTotal}`
                  : toPass.length}
              </span>
            </div>
            {toPass.length === 0 ? (
              <div className="pfu-empty">Nothing of yours queued to pass.</div>
            ) : (
              toPass.map(renderItem)
            )}
          </div>

          <div className="pfu-section">
            <div className="pfu-section-head">
              Recent meetings
              <span className="pfu-count">{recent.length}</span>
            </div>
            {recent.length === 0 ? (
              <div className="pfu-empty">No other recent meetings.</div>
            ) : (
              recent.map(renderItem)
            )}
          </div>
        </>
      )}
    </div>
  );
}
