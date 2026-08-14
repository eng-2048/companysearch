// Shared fuzzy-but-safe matching helpers.
// The recurring bug across Attio and Grain is that substring search matches
// coincidental fragments ("verno" ⊂ "Vernon", "Governors"). Requiring the term
// as a WHOLE WORD kills those while still tolerating punctuation and casing.

export function normalize(s: string): string {
  // Punctuation (incl. parentheses) becomes spaces — so "Oliver Wesche(Verno AI)"
  // yields the token "verno". We deliberately do NOT drop parenthetical *content*
  // here: callers that want to strip "(Stealth)" from a name do it explicitly.
  return s
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** True if `needle` appears as a whole word (or whole phrase) in `haystack`. */
export function wholeWordMatch(haystack: string, needle: string): boolean {
  const h = ` ${normalize(haystack)} `;
  const n = normalize(needle);
  if (!n) return false;
  return h.includes(` ${n} `);
}
