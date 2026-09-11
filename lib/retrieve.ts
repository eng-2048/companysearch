// Lightweight lexical retrieval for the company Q&A. The heavy sources (Grain
// transcript, deck, Slack) are big; for a specific question we send only the most
// relevant chunks instead of the whole thing (much cheaper). Broad/complex
// questions bypass this and get the full context (see isBroadQuestion). No model,
// no dependency — keyword/frequency scoring.

const STOP = new Set([
  "the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "with", "is", "are", "was", "were",
  "be", "been", "being", "what", "did", "do", "does", "how", "why", "who", "when", "where", "which",
  "that", "this", "these", "those", "they", "them", "their", "it", "its", "as", "at", "by", "from",
  "about", "we", "our", "us", "you", "your", "i", "me", "my", "can", "could", "would", "should",
  "will", "have", "has", "had", "if", "then", "so", "but", "not", "any", "all", "some", "more",
  "much", "many", "tell", "say", "said", "give", "get", "there", "here", "into", "out", "up", "down",
]);

export function queryTerms(q: string): string[] {
  return [
    ...new Set(
      q
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .split(/\s+/)
        .filter((t) => t.length >= 3 && !STOP.has(t))
    ),
  ];
}

const BROAD_RE =
  /\b(summar|overview|everything|walk me through|walkthrough|deep ?dive|comprehensive|full picture|big picture|the memo|thesis|diligence|pros and cons|should we|overall|in general|catch me up|brief me|rundown|recap|whole (?:story|picture)|top to bottom)\b/i;

/** Broad/complex questions want the whole picture — skip retrieval, send full. */
export function isBroadQuestion(q: string): boolean {
  return BROAD_RE.test(q);
}

export interface Source {
  label: string;
  text: string;
}

function chunk(text: string, size = 900): string[] {
  const lines = text.split(/\n+/).map((l) => l.trim()).filter(Boolean);
  const out: string[] = [];
  let cur = "";
  for (const l of lines) {
    if (cur && (cur + "\n" + l).length > size) {
      out.push(cur);
      cur = l;
    } else {
      cur = cur ? cur + "\n" + l : l;
    }
  }
  if (cur) out.push(cur);
  return out;
}

export interface Retrieved {
  text: string;
  hits: number;
}

/** Select the most relevant chunks across the sources for the question. */
export function retrieve(sources: Source[], question: string, budgetChars = 14000): Retrieved {
  const terms = queryTerms(question);
  if (!terms.length) return { text: "", hits: 0 };

  interface C {
    label: string;
    idx: number;
    text: string;
    score: number;
  }
  const chunks: C[] = [];
  for (const s of sources) {
    chunk(s.text).forEach((t, idx) => {
      const low = t.toLowerCase();
      let score = 0;
      for (const term of terms) {
        let i = 0;
        let c = 0;
        while ((i = low.indexOf(term, i)) >= 0) {
          c++;
          i += term.length;
        }
        if (c) score += 1 + Math.log(1 + c); // term presence + dampened frequency
      }
      if (score > 0) chunks.push({ label: s.label, idx, text: t, score });
    });
  }
  chunks.sort((a, b) => b.score - a.score);

  const picked: C[] = [];
  let total = 0;
  for (const c of chunks) {
    if (total + c.text.length > budgetChars) continue;
    picked.push(c);
    total += c.text.length;
  }
  if (!picked.length) return { text: "", hits: 0 };

  // Group by source, restore reading order within each.
  const bySource = new Map<string, C[]>();
  for (const c of picked) {
    if (!bySource.has(c.label)) bySource.set(c.label, []);
    bySource.get(c.label)!.push(c);
  }
  const parts: string[] = [];
  for (const [label, cs] of bySource) {
    cs.sort((a, b) => a.idx - b.idx);
    parts.push(`## Relevant excerpts — ${label}\n${cs.map((c) => c.text).join("\n…\n")}`);
  }
  return { text: parts.join("\n\n"), hits: picked.length };
}
