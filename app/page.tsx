"use client";

import { useState, useRef } from "react";
import { ContextBundle, SearchEvent } from "@/lib/types";
import ResultCard from "@/components/ResultCard";

export default function Home() {
  const [query, setQuery] = useState("");
  const [statuses, setStatuses] = useState<string[]>([]);
  const [bundle, setBundle] = useState<ContextBundle | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  async function run(e: React.FormEvent) {
    e.preventDefault();
    const name = query.trim();
    if (!name || loading) return;

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

        // NDJSON: one JSON event per line
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          const evt: SearchEvent = JSON.parse(line);
          if (evt.type === "status") {
            setStatuses((s) => [...s, evt.message]);
          } else if (evt.type === "bundle") {
            setBundle(evt.bundle);
          } else if (evt.type === "error") {
            setError(evt.message);
          }
        }
      }
    } catch (err: any) {
      if (err?.name !== "AbortError") {
        setError(err?.message ?? "Something went wrong");
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="wrap">
      <div className="masthead">
        <h1>Company Search</h1>
        <span className="brand">2048 Ventures</span>
      </div>
      <p className="subtitle">
        Type a company or founder. Get everything the firm already knows —
        Attio, Calendar, Grain, and email, reconciled into one bundle.
      </p>

      <form className="searchbar" onSubmit={run}>
        <input
          type="text"
          placeholder="e.g. Marc Theermann (Stealth)  ·  Dynamic Creatures"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          autoFocus
        />
        <button type="submit" disabled={loading || !query.trim()}>
          {loading ? "Gathering…" : "Search"}
        </button>
      </form>
      <p className="hint">
        Paste a founder name, a company, or both. Context-gathering only — no
        analysis or scoring.
      </p>

      {(loading || statuses.length > 0) && (
        <div className="status-strip">
          {statuses.map((s, i) => {
            const isLast = i === statuses.length - 1;
            const showSpinner = loading && isLast && !bundle;
            return (
              <div key={i} className={`status-line ${showSpinner ? "" : "done"}`}>
                {showSpinner ? <span className="spinner" /> : <span className="spinner" />}
                <span>{s}</span>
              </div>
            );
          })}
        </div>
      )}

      {error && <div className="error-box">⚠ {error}</div>}

      {bundle && <ResultCard bundle={bundle} />}
    </div>
  );
}
