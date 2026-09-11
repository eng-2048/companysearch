"use client";

import { useState } from "react";
import { ContextBundle } from "@/lib/types";

interface QA {
  q: string;
  a?: string;
  used?: string[];
  note?: string;
  loading: boolean;
}

export default function AskBox({ bundle }: { bundle: ContextBundle }) {
  const [q, setQ] = useState("");
  const [history, setHistory] = useState<QA[]>([]);
  const [busy, setBusy] = useState(false);

  const EXAMPLES = [
    "What did they say about competition?",
    "How big is the round?",
    "Summarize the last call",
  ];

  async function ask(preset?: string) {
    const question = (preset ?? q).trim();
    if (!question || busy) return;
    setBusy(true);
    setQ("");
    const idx = history.length;
    setHistory((h) => [...h, { q: question, loading: true }]);
    try {
      const res = await fetch("/api/search/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question, bundle }),
      });
      const j = await res.json();
      setHistory((h) =>
        h.map((item, i) =>
          i === idx
            ? { q: question, a: j.answer, used: j.used, note: j.ok ? undefined : j.note, loading: false }
            : item
        )
      );
    } catch {
      setHistory((h) =>
        h.map((item, i) => (i === idx ? { q: question, note: "Request failed.", loading: false } : item))
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="ask">
      <div className="ask-head">
        <span className="ask-spark" aria-hidden="true">✦</span> Ask about {bundle.company}
      </div>
      <form
        className="ask-bar"
        onSubmit={(e) => {
          e.preventDefault();
          ask();
        }}
      >
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Ask anything about the materials on file…"
          disabled={busy}
        />
        <button type="submit" disabled={busy || !q.trim()}>
          {busy ? "Thinking…" : "Ask"}
        </button>
      </form>
      {history.length === 0 && (
        <div className="ask-prompts">
          {EXAMPLES.map((ex) => (
            <button key={ex} type="button" className="ask-prompt" onClick={() => ask(ex)} disabled={busy}>
              {ex}
            </button>
          ))}
        </div>
      )}
      {[...history].reverse().map((item, i) => (
        <div className="ask-qa" key={history.length - 1 - i}>
          <div className="ask-q">{item.q}</div>
          {item.loading ? (
            <div className="status-line">
              <span className="spinner" />
              <span>Reading the transcript and materials…</span>
            </div>
          ) : item.a ? (
            <>
              <div className="ask-a">{item.a}</div>
              {item.used?.length ? (
                <div className="ask-used">
                  <span className="ask-used-lbl">Sources</span>
                  {item.used.map((u, ui) => (
                    <span className="ask-src" key={ui}>
                      {u}
                    </span>
                  ))}
                </div>
              ) : null}
            </>
          ) : (
            <div className="ask-note">⚠ {item.note}</div>
          )}
        </div>
      ))}
    </div>
  );
}
