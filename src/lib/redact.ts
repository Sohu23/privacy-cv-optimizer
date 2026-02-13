export type RedactionPlaceholder =
  | "EMAIL"
  | "PHONE"
  | "ADDRESS"
  | "POSTAL_CODE"
  | "DOB"
  | "DATE"
  | "URL"
  | "ID"
  | "NAME";

export type Redaction = {
  type: RedactionPlaceholder;
  match: string;
  replacement: string;
  index: number;
};

export type RedactionResult = {
  text: string;
  redactions: Redaction[];
};

function stableToken(type: RedactionPlaceholder, n: number) {
  return `[${type}_${n}]`;
}

/**
 * Privacy-first redaction that runs WITHOUT any LLM.
 *
 * Notes:
 * - We always redact: email, phone, street address fragments, postal codes, URLs, IDs.
 * - "Names always" is hard to do perfectly without a full NER pipeline.
 *   For MVP we use conservative heuristics + (optionally) a provided displayName.
 */
export function redactPII(input: string, opts?: { displayName?: string | null }): RedactionResult {
  let text = input;
  const redactions: Redaction[] = [];

  const add = (type: RedactionPlaceholder, match: string, index: number, replacement: string) => {
    redactions.push({ type, match, index, replacement });
  };

  // 1) Emails
  {
    const re = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
    let i = 0;
    text = text.replace(re, (m, offset) => {
      i += 1;
      const rep = stableToken("EMAIL", i);
      add("EMAIL", m, offset, rep);
      return rep;
    });
  }

  // 2) URLs
  {
    const re = /\bhttps?:\/\/[^\s)\]]+|\bwww\.[^\s)\]]+/gi;
    let i = 0;
    text = text.replace(re, (m, offset) => {
      i += 1;
      const rep = stableToken("URL", i);
      add("URL", m, offset, rep);
      return rep;
    });
  }

  // 3) Phone numbers (broad)
  {
    const re = /(?:(?:\+|00)\s?\d{1,3}[\s\-]?)?(?:\(?\d{2,5}\)?[\s\-]?)\d{3,}(?:[\s\-]?\d{2,})+/g;
    let i = 0;
    text = text.replace(re, (m, offset) => {
      // Avoid redacting years like 2020-2023 (handled later)
      if (/^\d{4}\s?[-–]\s?\d{4}$/.test(m.trim())) return m;
      i += 1;
      const rep = stableToken("PHONE", i);
      add("PHONE", m, offset, rep);
      return rep;
    });
  }

  // 4) Postal codes (DE/AT/CH-ish). We only replace standalone 4-5 digit sequences.
  {
    const re = /\b\d{4,5}\b/g;
    let i = 0;
    text = text.replace(re, (m, offset) => {
      // Heuristic: don’t redact common years 19xx/20xx when surrounded by date context.
      const before = text.slice(Math.max(0, offset - 10), offset);
      const after = text.slice(offset + m.length, offset + m.length + 10);
      if (/\b(19|20)\d{2}\b/.test(m) && /[.\-/]/.test(before + after)) return m;
      i += 1;
      const rep = stableToken("POSTAL_CODE", i);
      add("POSTAL_CODE", m, offset, rep);
      return rep;
    });
  }

  // 5) Street-ish addresses (very heuristic)
  // Examples: "Musterstraße 12", "Hauptstr. 5a"
  {
    const re = /\b([A-ZÄÖÜ][\p{L}ßäöü.-]{2,}\s?(?:straße|str\.|strasse|weg|allee|gasse|ring|platz|damm|ufer))\s+\d{1,4}\s?[a-zA-Z]?\b/giu;
    let i = 0;
    text = text.replace(re, (m, offset) => {
      i += 1;
      const rep = stableToken("ADDRESS", i);
      add("ADDRESS", m, offset, rep);
      return rep;
    });
  }

  // 6) Date of birth lines (DOB)
  {
    const re = /(geb\.?|geboren|date of birth|dob)\s*[:\-]?\s*(\d{1,2}[./-]\d{1,2}[./-]\d{2,4}|\d{4}-\d{2}-\d{2})/gi;
    let i = 0;
    text = text.replace(re, (m, offset) => {
      i += 1;
      const rep = `DOB: ${stableToken("DOB", i)}`;
      add("DOB", m, offset, rep);
      return rep;
    });
  }

  // 7) Generic dates (keep coarse)
  {
    const re = /\b(\d{1,2}[./-]\d{1,2}[./-]\d{2,4}|\d{4}-\d{2}-\d{2})\b/g;
    let i = 0;
    text = text.replace(re, (m, offset) => {
      i += 1;
      const rep = stableToken("DATE", i);
      add("DATE", m, offset, rep);
      return rep;
    });
  }

  // 8) IDs (IBAN-ish, tax IDs, etc.)
  {
    const re = /\b([A-Z]{2}\d{2}[A-Z0-9]{11,30}|\d{11}\b|\d{2}\/\d{3}\/\d{3}\/\d{3})\b/g;
    let i = 0;
    text = text.replace(re, (m, offset) => {
      i += 1;
      const rep = stableToken("ID", i);
      add("ID", m, offset, rep);
      return rep;
    });
  }

  // 9) Names: best-effort.
  // - If displayName provided, always replace it.
  // - Also replace a likely "name line" at the top (first non-empty line) if it looks like 2-4 capitalized tokens.
  {
    const displayName = opts?.displayName?.trim();
    if (displayName) {
      const esc = displayName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp(`\\b${esc}\\b`, "g");
      let i = 0;
      text = text.replace(re, (m, offset) => {
        i += 1;
        const rep = stableToken("NAME", i);
        add("NAME", m, offset, rep);
        return rep;
      });
    }

    // Name line heuristic
    const lines = text.split(/\r?\n/);
    const firstNonEmptyIdx = lines.findIndex((l) => l.trim().length > 0);
    if (firstNonEmptyIdx >= 0) {
      const line = lines[firstNonEmptyIdx].trim();
      const tokens = line.split(/\s+/).filter(Boolean);
      const looksLikeName =
        tokens.length >= 2 &&
        tokens.length <= 4 &&
        tokens.every((t) => /^[A-ZÄÖÜ][\p{L}ßäöü'-]+$/u.test(t)) &&
        !/(GmbH|AG|UG|Inc\.|LLC|University|Universität|Hochschule)/i.test(line);

      if (looksLikeName) {
        lines[firstNonEmptyIdx] = stableToken("NAME", 1);
        text = lines.join("\n");
        add("NAME", line, 0, stableToken("NAME", 1));
      }
    }
  }

  return { text, redactions };
}

export function assertNoPIILeakage(text: string) {
  // Lightweight sanity checks for the most common leakage.
  const hasEmail = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(text);
  const hasUrl = /\bhttps?:\/\//i.test(text);
  return { hasEmail, hasUrl };
}
