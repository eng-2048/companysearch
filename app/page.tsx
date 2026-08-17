"use client";

import { useState, useRef, useEffect } from "react";
import { ContextBundle, SearchEvent, PrepResult } from "@/lib/types";
import { to12h } from "@/lib/match";
import ResultCard from "@/components/ResultCard";
import MeetingPrep from "@/components/MeetingPrep";

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
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [sugs, setSugs] = useState<Suggestions>({ configured: false, upcoming: [], recent: [] });
  const [open, setOpen] = useState(false);
  const [prepMode, setPrepMode] = useState(false);
  const [prepData, setPrepData] = useState<PrepResult | null>(null);
  const [prepLoading, setPrepLoading] = useState(false);
  const comboRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  async function openPrep() {
    setPrepMode(true);
    setPrepLoading(true);
    setPrepData(null);
    try {
      const res = await fetch("/api/meeting-prep");
      setPrepData(await res.json());
    } catch {
      setPrepData({ configured: false, days: [] });
    } finally {
      setPrepLoading(false);
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

  async function run(term?: string) {
    const name = (term ?? query).trim();
    if (!name || loading) return;

    setQuery(name);
    setOpen(false);
    setLoading(true);
    setStatuses([]);
    setBundle(null);
    setError(null);

    const ctrl = new AbortController();
    abortRef.current = ctrl;

    try {
      const res = await fetch("/api/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: name }),
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
        <button className="prep-btn" onClick={openPrep}>
          Meeting Prep
        </button>
      </div>
      <p className="subtitle">
        Search a company or founder — or pick one of this week&apos;s meetings to prep.
      </p>

      {prepMode ? (
        <MeetingPrep data={prepData} loading={prepLoading} onClose={() => setPrepMode(false)} />
      ) : (
        <>
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
      {bundle && <ResultCard bundle={bundle} />}
        </>
      )}
    </div>
  );
}
