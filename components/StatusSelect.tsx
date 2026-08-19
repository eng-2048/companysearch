"use client";

import { useState } from "react";

export function statusClass(status?: string): string {
  if (!status) return "st-neutral";
  const s = status.toLowerCase();
  if (s.includes("pass") || s.includes("lost")) return "st-red";
  if (s.includes("watch")) return "st-orange";
  if (s.includes("termsheet") || s.includes("closing") || s.includes("closed")) return "st-blue";
  if (s.includes("new") || s.includes("screen") || s.includes("deep dive") || s.includes("diligence"))
    return "st-green";
  return "st-neutral";
}

const defaultFollowUp = (): string => new Date(Date.now() + 90 * 864e5).toISOString().slice(0, 10);

/**
 * Editable pipeline status — writes to Attio on select. Moving a deal to "Watch"
 * reveals a follow-up date (defaulted, editable) that's written to the deal's
 * Follow Up Date, so a check-in date is always captured — anywhere this is used.
 */
export default function StatusSelect({
  entryId,
  status,
  forwardStatuses,
  onChanged,
}: {
  entryId: string;
  status: string;
  forwardStatuses: string[];
  onChanged?: (next: string) => void;
}) {
  const [value, setValue] = useState(status);
  const [state, setState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [showDate, setShowDate] = useState(status.toLowerCase() === "watch");
  const [followUp, setFollowUp] = useState(defaultFollowUp());

  async function write(next: string, date?: string): Promise<boolean> {
    setState("saving");
    try {
      const res = await fetch("/api/update-status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entryId, status: next, followUpDate: date }),
      });
      const j = await res.json();
      if (!j.ok) throw new Error();
      setState("saved");
      setTimeout(() => setState("idle"), 1500);
      return true;
    } catch {
      setState("error");
      setTimeout(() => setState("idle"), 2500);
      return false;
    }
  }

  async function change(next: string) {
    if (next === value) return;
    const prev = value;
    setValue(next);
    const isWatch = next.toLowerCase() === "watch";
    // For Watch, capture a follow-up date up front (default +90d, editable below).
    const date = isWatch ? defaultFollowUp() : undefined;
    if (isWatch) {
      setFollowUp(date!);
      setShowDate(true);
    } else {
      setShowDate(false);
    }
    const ok = await write(next, date);
    if (!ok) {
      setValue(prev);
      setShowDate(prev.toLowerCase() === "watch");
      return;
    }
    onChanged?.(next);
  }

  async function changeDate(d: string) {
    setFollowUp(d);
    if (/^\d{4}-\d{2}-\d{2}$/.test(d)) await write("Watch", d);
  }

  const opts = value ? [value, ...forwardStatuses.filter((s) => s !== value)] : forwardStatuses;

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
      {showDate && (
        <span className="fu-date" title="Follow Up Date — written to Attio">
          <span className="fu-label">follow-up</span>
          <input type="date" value={followUp} onChange={(e) => changeDate(e.target.value)} />
        </span>
      )}
      {state === "saving" && <span className="save-ind">saving…</span>}
      {state === "saved" && <span className="save-ind ok">✓ saved</span>}
      {state === "error" && <span className="save-ind err">! failed</span>}
    </span>
  );
}
