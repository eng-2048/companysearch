"use client";

import { useState, useRef, useEffect } from "react";
import { ContextBundle, SearchEvent, PrepResult, FormEntryList, PassFollowUpList, SearchCandidate } from "@/lib/types";
import { to12h } from "@/lib/match";
import ResultCard from "@/components/ResultCard";
import AskBox from "@/components/AskBox";
import MeetingPrep from "@/components/MeetingPrep";
import FormEntry from "@/components/FormEntry";
import PassFollowUp from "@/components/PassFollowUp";

interface Suggestion {
  term: string;
  title: string;
  date: string;
  time?: string;
  upcoming: boolean;
}
interface Suggestions {
  configured: boolean;
  upcoming: Suggestion[];
  recent: Suggestion[];
}

function fmtDay(d: string): string {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const dt = new Date(d + "T00:00:00");
  const diff = Math.round((dt.getTime() - today.getTime()) / 864e5);
  if (diff === 0) return "Today";
  if (diff === 1) return "Tomorrow";
  if (diff === -1) return "Yesterday";
  return dt.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

export default function Home() {
  const [query, setQuery] = useState("");
  const [statuses, setStatuses] = useState<string[]>([]);
  const [bundle, setBundle] = useState<ContextBundle | null>(null);
  const [candidates, setCandidates] = useState<{ query: string; options: SearchCandidate[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [sugs, setSugs] = useState<Suggestions>({ configured: false, upcoming: [], recent: [] });
  const [open, setOpen] = useState(false);
  const [prepMode, setPrepMode] = useState(false);
  const [prepData, setPrepData] = useState<PrepResult | null>(null);
  const [prepLoading, setPrepLoading] = useState(false);
  const [formMode, setFormMode] = useState(false);
  const [formData, setFormData] = useState<FormEntryList | null>(null);
  const [formLoading, setFormLoading] = useState(false);
  const [passMode, setPassMode] = useState(false);
  const [passData, setPassData] = useState<PassFollowUpList | null>(null);
  const [passLoading, setPassLoading] = useState(false);
  const comboRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  async function openPrep(force = false) {
    setFormMode(false);
    setPassMode(false);
    setPrepMode(true);
    // Reuse this session's scan when navigating back — no refetch. The server
    // also day-caches, so even a fresh load / reload is instant after the first.
    if (!force && prepData) return;
    setPrepLoading(true);
    if (!force) setPrepData(null); // first load shows the spinner; refresh keeps old data
    try {
      const res = await fetch(`/api/meeting-prep${force ? "?refresh=1" : ""}`);
      setPrepData(await res.json());
    } catch {
      setPrepData({ configured: false, days: [] });
    } finally {
      setPrepLoading(false);
    }
  }

  async function openForm(force = false) {
    setPrepMode(false);
    setPassMode(false);
    setFormMode(true);
    // Reuse this session's list (and any drafted cards) — no refetch on return.
    if (!force && formData) return;
    setFormLoading(true);
    if (!force) setFormData(null);
    try {
      const res = await fetch(`/api/form-entry${force ? "?refresh=1" : ""}`);
      setFormData(await res.json());
    } catch {
      setFormData({ configured: false, meetings: [] });
    } finally {
      setFormLoading(false);
    }
  }

  async function openPass(force = false) {
    setPrepMode(false);
    setFormMode(false);
    setPassMode(true);
    // Reuse this session's list (and any in-progress drafts) — no refetch on return.
    if (!force && passData) return;
    setPassLoading(true);
    if (!force) setPassData(null);
    try {
      const res = await fetch(`/api/pass-follow-up${force ? "?refresh=1" : ""}`);
      setPassData(await res.json());
    } catch {
      setPassData({ configured: false, testMode: true, testRecipient: "zannali@gmail.com", toPass: [], recent: [] });
    } finally {
      setPassLoading(false);
    }
  }

  useEffect(() => {
    fetch("/api/suggestions")
      .then((r) => r.json())
      .then(setSugs)
      .catch(() => {});
  }, []);

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (comboRef.current && !comboRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  async function run(term?: string, recordId?: string) {
    const name = (term ?? query).trim();
    if (!name || loading) return;

    setQuery(name);
    setOpen(false);
    setLoading(true);
    setStatuses([]);
    setBundle(null);
    setCandidates(null);
    setError(null);

    const ctrl = new AbortController();
    abortRef.current = ctrl;

    try {
      const res = await fetch("/api/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: name, recordId }),
        signal: ctrl.signal,
      });
      if (!res.body) throw new Error("No response stream");

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          const evt: SearchEvent = JSON.parse(line);
          if (evt.type === "status") setStatuses((s) => [...s, evt.message]);
          else if (evt.type === "candidates") setCandidates({ query: evt.query, options: evt.options });
          else if (evt.type === "bundle") setBundle(evt.bundle);
          else if (evt.type === "error") setError(evt.message);
        }
      }
    } catch (err: any) {
      if (err?.name !== "AbortError") setError(err?.message ?? "Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  const q = query.trim().toLowerCase();
  const match = (arr: Suggestion[]) =>
    q ? arr.filter((s) => s.term.toLowerCase().includes(q) || s.title.toLowerCase().includes(q)) : arr;
  const up = match(sugs.upcoming);
  const rec = match(sugs.recent);
  const showDrop = open && sugs.configured && up.length + rec.length > 0;

  const Row = (s: Suggestion) => (
    <button
      type="button"
      className="dd-row"
      key={s.title + s.date}
      // mousedown (not click) so it fires before the input blur closes the panel
      onMouseDown={(e) => {
        e.preventDefault();
        run(s.term);
      }}
    >
      <span className="dd-term">{s.term}</span>
      <span className="dd-meta">
        {fmtDay(s.date)}
        {s.time ? ` · ${to12h(s.time)}` : ""} · {s.title}
      </span>
    </button>
  );

  return (
    <div className="wrap">
      <div className="masthead">
        <h1>Company Search</h1>
        <span className="brand">2048 Ventures</span>
        <div className="mast-actions">
          <button className="prep-btn" onClick={() => openPrep()}>
            Meeting Prep
          </button>
          <button className="prep-btn" onClick={() => openForm()}>
            Form Entry
          </button>
          <button className="prep-btn" onClick={() => openPass()}>
            Pass / Follow-Up
          </button>
        </div>
      </div>
      <p className="subtitle">
        Search a company or founder — or pick one of this week&apos;s meetings to prep.
      </p>

      {prepMode ? (
        <MeetingPrep
          data={prepData}
          loading={prepLoading}
          onRefresh={() => openPrep(true)}
          onClose={() => setPrepMode(false)}
        />
      ) : (
        <>
        {/* Form Entry and Pass/Follow-Up stay mounted (just hidden) so drafted
            cards + edits survive navigating back to Search. */}
        <div hidden={formMode || passMode}>
      <form
        className="searchbar"
        onSubmit={(e) => {
          e.preventDefault();
          run();
        }}
      >
        <div className="combo" ref={comboRef}>
          <input
            type="text"
            placeholder="e.g. Verno · Autonomy Health · a founder's name"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setOpen(true);
            }}
            onFocus={() => setOpen(true)}
            autoFocus
          />
          {showDrop && (
            <div className="dropdown">
              <div className="dd-hint">Your meetings · past & upcoming week</div>
              {up.length > 0 && <div className="dd-group">Upcoming</div>}
              {up.map(Row)}
              {rec.length > 0 && <div className="dd-group">Recent</div>}
              {rec.map(Row)}
            </div>
          )}
        </div>
        <button type="submit" disabled={loading || !query.trim()}>
          {loading ? "Gathering…" : "Search"}
        </button>
      </form>
      <p className="hint">
        Context-gathering only — no analysis or scoring.
        {sugs.configured ? "" : " (Connect Google Calendar to see meeting pre-selects.)"}
      </p>

      {(loading || statuses.length > 0) && (
        <div className="status-strip">
          {statuses.map((s, i) => {
            const isLast = i === statuses.length - 1;
            const showSpinner = loading && isLast && !bundle;
            return (
              <div key={i} className={`status-line ${showSpinner ? "" : "done"}`}>
                <span className="spinner" />
                <span>{s}</span>
              </div>
            );
          })}
        </div>
      )}

      {error && <div className="error-box">⚠ {error}</div>}

      {candidates && !bundle && (
        <div className="candidates">
          <div className="cand-hint">
            A few records match &ldquo;{candidates.query}&rdquo; — pick the right one:
          </div>
          {candidates.options.map((o) => (
            <button
              key={o.recordId}
              type="button"
              className="cand-row"
              onClick={() => run(candidates.query, o.recordId)}
            >
              <div className="cand-top">
                <span className="cand-name">
                  {o.name}
                  {o.isStealth ? " (stealth)" : ""}
                </span>
                {o.status ? (
                  <span className="pill status">{o.status}</span>
                ) : (
                  <span className="cand-nodeal">no deal record</span>
                )}
              </div>
              <div className="cand-meta">
                {[o.description, o.domain, o.location].filter(Boolean).join(" · ") || "—"}
              </div>
            </button>
          ))}
        </div>
      )}

      {bundle && <ResultCard bundle={bundle} />}
      {bundle && (
        <AskBox key={bundle.identity?.attioCompanyId || bundle.company} bundle={bundle} />
      )}
        </div>
        <div hidden={!formMode}>
          <FormEntry
            data={formData}
            loading={formLoading}
            onRefresh={() => openForm(true)}
            onClose={() => setFormMode(false)}
          />
        </div>
        <div hidden={!passMode}>
          <PassFollowUp
            data={passData}
            loading={passLoading}
            onRefresh={() => openPass(true)}
            onClose={() => setPassMode(false)}
          />
        </div>
        </>
      )}
    </div>
  );
}
