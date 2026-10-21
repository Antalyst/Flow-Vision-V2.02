// Office codes generated from the office's name: 2–4 uppercase letters or digits, e.g.
//   Human Resources → HR · Budget Office → BO · City Planning Office → CPO · Records → REC
// One function serves the live preview in the browser and the server, which picks the final code
// itself (the preview is never trusted). Candidates come in a fixed order, so the same name and the
// same codes already in use always give the same result; nothing random is involved.
//
// An umbrella office's code is its office's code plus a generated suffix: CHO + Sanitation Unit →
// CHO-SU. Existing codes are never rewritten; a new code is generated only on creation, or on edit
// when the user explicitly asks for it.

export const GENERATED_CODE_RE = /^[A-Z0-9]{2,4}$/

/** Words that carry no meaning in an office name. */
const STOP_WORDS = new Set(['OF', 'THE', 'AND', 'FOR', 'A', 'AN', 'IN', 'ON', 'AT', 'TO', 'NG', 'SA', 'DE'])

/** The meaningful words of a name, uppercase, without accents or punctuation. */
export function codeWords(name: string): string[] {
  const words = name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
  const meaningful = words.filter((w) => !STOP_WORDS.has(w))
  return meaningful.length ? meaningful : words
}

const VOWELS = /[AEIOU]/g

/**
 * Every code a name may get, best first: the initials (or the start of a single word), then
 * readable letter variants, then the base with a number (HR2, HR3 … HR99). All are 2–4 characters.
 */
export function codeCandidates(name: string): string[] {
  const words = codeWords(name)
  if (!words.length) return []
  const out: string[] = []
  const add = (c: string) => {
    if (GENERATED_CODE_RE.test(c) && !out.includes(c)) out.push(c)
  }

  // An acronym the name already gives wins: "Bureau of Fire Protection (BFP)" → BFP.
  const given = /\(([A-Za-z0-9]{2,4})\)/.exec(name)?.[1]?.toUpperCase()
  if (given) add(given)

  let base: string
  if (words.length === 1) {
    const w = words[0]!
    base = w.length <= 4 ? w : w.slice(0, 3)
    add(base)
    add(w.slice(0, 4))
    // Consonant outline, e.g. RECORDS → RCR, then RCRD.
    const outline = w[0] + w.slice(1).replace(VOWELS, '')
    add(outline.slice(0, 3))
    add(outline.slice(0, 4))
  } else {
    const initials = words.map((w) => w[0]).join('')
    base = initials.slice(0, 4)
    add(base)
    if (base.length < 4) {
      // More letters from the last word, then from the first word: BO → BOF, BUO.
      const last = words[words.length - 1]!
      const first = words[0]!
      for (let i = 1; i < last.length && base.length + 1 <= 4; i++) add(`${base}${last[i]}`)
      if (first.length > 1) add(`${first.slice(0, 2)}${initials.slice(1)}`.slice(0, 4))
    }
  }
  // Then the base with a number, which keeps it recognizable: HR2 … HR99, CPO2 … CP99. A one-letter
  // name (e.g. "X") only gets these: X2, X3 …
  for (let n = 2; n <= 99; n++) {
    const s = String(n)
    add(`${base.slice(0, Math.max(1, 4 - s.length))}${s}`)
  }
  return out
}

/** The first candidate not in `taken` (uppercase codes or suffixes), or null when none is left. */
export function pickCode(name: string, taken: Iterable<string>): string | null {
  const used = new Set([...taken].map((c) => c.toUpperCase()))
  return codeCandidates(name).find((c) => !used.has(c)) ?? null
}
