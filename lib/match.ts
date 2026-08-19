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

/**
 * Strip everything but letters and digits: "Pin 24" / "pin24" / "Pin-24" all
 * become "pin24". Used for space- and punctuation-insensitive name comparison,
 * where Attio's byte-literal `$contains` would otherwise miss (a user types
 * "pin24" but the record is stored "Pin 24"). Unlike normalize(), it also drops
 * whitespace, so it must NOT be used as a whole-word matcher.
 */
export function squish(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** "16:15" -> "4:15 PM". Formats a 24h HH:MM string as 12-hour with AM/PM. */
export function to12h(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  if (Number.isNaN(h)) return hhmm;
  const ampm = h < 12 ? "AM" : "PM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m ?? 0).padStart(2, "0")} ${ampm}`;
}

/** True if `needle` appears as a whole word (or whole phrase) in `haystack`. */
export function wholeWordMatch(haystack: string, needle: string): boolean {
  const h = ` ${normalize(haystack)} `;
  const n = normalize(needle);
  if (!n) return false;
  return h.includes(` ${n} `);
}
