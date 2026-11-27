/*
 * Coding Sessions — parse pasted secrets for Settings › Secrets › Import.
 * Runs in the browser only; nothing here sends, stores or logs a value. The server checks
 * every entry again (POST /api/secrets/import/preview), so this parse is a convenience.
 *
 * window.SecretImport.parse(text, format) → {
 *   format: "env" | "json",
 *   entries: [{ name, value, line?, error?, suggestion? }],   // error: a reason this parse already knows
 *   problems: [{ line?, reason }],                            // text that is not an entry at all
 * }
 * Reasons never quote a value.
 */
(() => {
  const NAME_RE = /^[A-Z][A-Z0-9_]{0,63}$/;

  /** The env-var form of a name such as api-key, or null when there is none. */
  function suggestName(name) {
    const upper = String(name).trim().toUpperCase().replace(/[^A-Z0-9_]/g, "_");
    return upper !== name && NAME_RE.test(upper) ? upper : null;
  }

  function entry(name, value, line) {
    const out = { name, value };
    if (line !== undefined) out.line = line;
    if (!NAME_RE.test(name)) {
      const suggestion = suggestName(name);
      out.error = suggestion ? `Not a valid name; did you mean ${suggestion}?` : "Not a valid name: use capitals, digits and underscores, starting with a letter.";
      if (suggestion) out.suggestion = suggestion;
    }
    return out;
  }

  const ESCAPES = { n: "\n", r: "\r", t: "\t", '"': '"', "\\": "\\" };

  /** KEY=VALUE lines, as most .env loaders read them. */
  function parseEnv(text) {
    const entries = [];
    const problems = [];
    let i = 0;
    let line = 1;
    const n = text.length;
    const lineEnd = from => { const at = text.indexOf("\n", from); return at === -1 ? n : at; };
    const countLines = (from, to) => { let c = 0; for (let k = from; k < to; k++) if (text[k] === "\n") c++; return c; };

    while (i < n) {
      const start = i;
      const startLine = line;
      const end = lineEnd(i);
      const raw = text.slice(i, end);
      const next = () => { i = end + 1; line = startLine + 1; };
      let rest = raw.replace(/^[ \t]+/, "");
      if (!rest.trim() || rest.startsWith("#")) { next(); continue; }
      rest = rest.replace(/^export[ \t]+/, "");
      const eq = rest.indexOf("=");
      if (eq === -1) { problems.push({ line: startLine, reason: "No = on this line." }); next(); continue; }
      const name = rest.slice(0, eq).trim();
      if (!name) { problems.push({ line: startLine, reason: "No name before the =." }); next(); continue; }
      // Where the value begins, as an index into text.
      const afterEq = start + (raw.length - rest.length) + eq + 1;
      let v = afterEq;
      while (v < end && (text[v] === " " || text[v] === "\t")) v++;
      const quote = text[v];

      if (quote === "'" || quote === '"') {
        let value = "";
        let k = v + 1;
        let closed = -1;
        while (k < n) {
          const c = text[k];
          if (c === quote) { closed = k; break; }
          if (quote === '"' && c === "\\" && k + 1 < n) {
            const e = text[k + 1];
            value += ESCAPES[e] !== undefined ? ESCAPES[e] : `\\${e}`;
            k += 2;
            continue;
          }
          value += c;
          k++;
        }
        if (closed === -1) { problems.push({ line: startLine, reason: `${name}: no closing ${quote === '"' ? "double" : "single"} quote.` }); next(); continue; }
        const closeEnd = lineEnd(closed);
        const trailing = text.slice(closed + 1, closeEnd);
        line = startLine + countLines(start, closed) + 1;
        i = closeEnd + 1;
        if (trailing.trim() && !/^[ \t]+#/.test(trailing) && !trailing.trim().startsWith("#")) {
          problems.push({ line: startLine, reason: `${name}: text after the closing quote.` });
          continue;
        }
        entries.push(entry(name, value, startLine));
        continue;
      }

      // An unquoted value ends at " #": a # with whitespace before it starts a comment.
      let value = text.slice(afterEq, end);
      const comment = value.search(/[ \t]#/);
      if (comment !== -1) value = value.slice(0, comment);
      entries.push(entry(name, value.trim(), startLine));
      next();
    }
    return { entries, problems };
  }

  /*
   * A flat JSON object. JSON.parse checks the syntax; a small scan then reads the
   * top-level keys in order, so a key given twice is reported instead of the last one
   * silently winning, and numbers keep their exact digits.
   */
  function parseJson(text) {
    try { JSON.parse(text); } catch {
      // The engine's message can quote the text, so it is not shown.
      return { entries: [], problems: [{ reason: "This is not valid JSON." }] };
    }
    let i = 0;
    const n = text.length;
    const ws = () => { while (i < n && /\s/.test(text[i])) i++; };
    const stringEnd = from => { let k = from + 1; while (text[k] !== '"') k += text[k] === "\\" ? 2 : 1; return k + 1; };
    const valueEnd = from => {
      if (text[from] === '"') return stringEnd(from);
      if (text[from] !== "{" && text[from] !== "[") { let k = from; while (k < n && !/[\s,}\]]/.test(text[k])) k++; return k; }
      let depth = 0;
      let k = from;
      while (k < n) {
        const c = text[k];
        if (c === '"') { k = stringEnd(k); continue; }
        if (c === "{" || c === "[") depth++;
        else if (c === "}" || c === "]") { depth--; if (depth === 0) return k + 1; }
        k++;
      }
      return k;
    };
    ws();
    if (text[i] !== "{") return { entries: [], problems: [{ reason: "Expected one JSON object of names and values, like {\"API_KEY\": \"…\"}." }] };
    i++;
    const entries = [];
    for (;;) {
      ws();
      if (text[i] === "}") break;
      const keyEnd = stringEnd(i);
      const name = JSON.parse(text.slice(i, keyEnd));
      i = keyEnd;
      ws(); i++; ws(); // the colon
      const end = valueEnd(i);
      const raw = text.slice(i, end);
      i = end;
      const parsed = JSON.parse(raw);
      if (typeof parsed === "string") entries.push(entry(name, parsed));
      else if (typeof parsed === "number") entries.push(entry(name, raw.trim()));
      else if (typeof parsed === "boolean") entries.push(entry(name, String(parsed)));
      else {
        const out = entry(name, "");
        out.error = parsed === null ? "null is not a value." : "Nested values are not supported.";
        entries.push(out);
      }
      ws();
      if (text[i] === ",") i++;
    }
    return { entries, problems: [] };
  }

  /** Marks every entry whose name appears more than once; none of them wins. */
  function markDuplicates(entries) {
    const counts = new Map();
    for (const e of entries) counts.set(e.name, (counts.get(e.name) || 0) + 1);
    for (const e of entries) if (!e.error && counts.get(e.name) > 1) e.error = "This name appears more than once in the import.";
    return entries;
  }

  function detectFormat(text) {
    return String(text).trim().startsWith("{") ? "json" : "env";
  }

  function parse(text, format = "auto") {
    const clean = String(text ?? "").replace(/^﻿/, "").replace(/\r\n?/g, "\n");
    const chosen = format === "env" || format === "json" ? format : detectFormat(clean);
    const result = chosen === "json" ? parseJson(clean) : parseEnv(clean);
    return { format: chosen, entries: markDuplicates(result.entries), problems: result.problems };
  }

  window.SecretImport = { parse, detectFormat, suggestName, NAME_RE };
})();
