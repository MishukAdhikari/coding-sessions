/* Safe markdown for agent text.
 *
 * Agent and tool text is untrusted. This module never parses HTML: it splits the
 * text into block and inline tokens, then builds DOM nodes with createElement and
 * textContent only. A tag such as <img onerror=…> stays literal text. Links are
 * kept only for http:, https: and mailto: and always open in a new tab with
 * rel="noopener noreferrer"; any other link renders as its label text.
 *
 * Supported: ATX headings, paragraphs (single newlines kept as line breaks),
 * ordered / unordered / task lists with nesting, block quotes, fenced code
 * (an unclosed fence runs to the end, so streaming code renders as code),
 * GitHub tables, rules, inline code, bold, italic, strikethrough, links,
 * <autolinks> and bare http(s) URLs.
 */
(function (root) {
  "use strict";

  const FENCE = /^ {0,3}(`{3,}|~{3,})[ \t]*([^\s`]*)[^`]*$/;
  const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
  const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
  const QUOTE = /^ {0,3}>[ ]?(.*)$/;
  const LIST = /^( *)([-*+]|\d{1,9}[.)])(?:[ \t]+(.*))?$/;
  const TABLE_SEP = /^ *\|? *:?-+:? *(?:\| *:?-+:? *)*\|? *$/;
  const MAX_DEPTH = 12;

  /* ---------- blocks ---------- */

  const indentOf = (line) => line.length - line.trimStart().length;
  const blank = (line) => line.trim() === "";

  function splitRow(line) {
    let s = line.trim();
    if (s.startsWith("|")) s = s.slice(1);
    if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
    const cells = [];
    let cell = "";
    for (let i = 0; i < s.length; i++) {
      if (s[i] === "\\" && s[i + 1] === "|") { cell += "|"; i++; }
      else if (s[i] === "|") { cells.push(cell.trim()); cell = ""; }
      else cell += s[i];
    }
    cells.push(cell.trim());
    return cells;
  }

  function startsBlock(line) {
    return FENCE.test(line) || HEADING.test(line) || RULE.test(line) || QUOTE.test(line) ||
      (LIST.test(line) && indentOf(line) < 4 && !!LIST.exec(line)[3]);
  }

  function isTableStart(lines, i) {
    if (!lines[i].includes("|") || i + 1 >= lines.length) return false;
    if (!TABLE_SEP.test(lines[i + 1]) || !lines[i + 1].includes("-")) return false;
    return splitRow(lines[i]).length === splitRow(lines[i + 1]).length;
  }

  function parseBlocks(lines, depth = 0) {
    const out = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (blank(line)) { i++; continue; }

      const fence = FENCE.exec(line);
      if (fence) {
        const mark = fence[1];
        const indent = indentOf(line);
        const body = [];
        i++;
        while (i < lines.length) {
          const close = lines[i].trim();
          if (close.startsWith(mark[0].repeat(mark.length)) && /^(`+|~+)$/.test(close) && close[0] === mark[0]) { i++; break; }
          body.push(indent ? lines[i].replace(new RegExp(`^ {0,${indent}}`), "") : lines[i]);
          i++;
        }
        out.push({ type: "code", lang: fence[2] || "", text: body.join("\n") });
        continue;
      }

      const heading = HEADING.exec(line);
      if (heading) { out.push({ type: "heading", level: heading[1].length, text: heading[2] || "" }); i++; continue; }

      if (RULE.test(line)) { out.push({ type: "rule" }); i++; continue; }

      if (QUOTE.test(line)) {
        const inner = [];
        while (i < lines.length && QUOTE.test(lines[i])) { inner.push(QUOTE.exec(lines[i])[1]); i++; }
        out.push({ type: "quote", children: depth < MAX_DEPTH ? parseBlocks(inner, depth + 1) : [{ type: "paragraph", text: inner.join("\n") }] });
        continue;
      }

      if (isTableStart(lines, i)) {
        const header = splitRow(lines[i]);
        const align = splitRow(lines[i + 1]).map((c) => (c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : c.startsWith(":") ? "left" : ""));
        const rows = [];
        i += 2;
        while (i < lines.length && !blank(lines[i]) && lines[i].includes("|")) {
          const cells = splitRow(lines[i]);
          rows.push(header.map((_, c) => cells[c] ?? ""));
          i++;
        }
        out.push({ type: "table", header, align, rows });
        continue;
      }

      const item = LIST.exec(line);
      if (item && indentOf(line) < 4 && (item[3] !== undefined || (i + 1 < lines.length && indentOf(lines[i + 1]) > indentOf(line)))) {
        const base = item[1].length;
        const ordered = /\d/.test(item[2]);
        const list = { type: "list", ordered, start: ordered ? parseInt(item[2], 10) : 1, items: [] };
        while (i < lines.length) {
          const m = LIST.exec(lines[i]);
          if (!m || m[1].length !== base || /\d/.test(m[2]) !== ordered) break;
          const contentIndent = base + m[2].length + 1;
          const body = [m[3] ?? ""];
          i++;
          while (i < lines.length) {
            const next = lines[i];
            if (blank(next)) {
              // A blank line stays inside the item only when indented content follows.
              let j = i + 1;
              while (j < lines.length && blank(lines[j])) j++;
              if (j < lines.length && indentOf(lines[j]) >= contentIndent) { while (i < j) { body.push(""); i++; } continue; }
              break;
            }
            const ind = indentOf(next);
            if (ind >= contentIndent || (ind > base && LIST.test(next))) { body.push(next.slice(Math.min(ind, contentIndent))); i++; continue; }
            if (ind <= base && (LIST.test(next) || startsBlock(next))) break;
            body.push(next.trimStart()); // lazy continuation of the item's paragraph
            i++;
          }
          let task = null;
          const box = /^\[([ xX])\][ \t]+/.exec(body[0]);
          if (box) { task = box[1] !== " "; body[0] = body[0].slice(box[0].length); }
          list.items.push({ task, children: depth < MAX_DEPTH ? parseBlocks(body, depth + 1) : [{ type: "paragraph", text: body.join("\n") }] });
          while (i < lines.length && blank(lines[i])) {
            const m2 = i + 1 < lines.length ? LIST.exec(lines[i + 1]) : null;
            if (m2 && m2[1].length === base && /\d/.test(m2[2]) === ordered) { i++; list.loose = true; } else break;
          }
        }
        out.push(list);
        continue;
      }

      const para = [line.trim()];
      i++;
      while (i < lines.length && !blank(lines[i]) && !startsBlock(lines[i]) && !isTableStart(lines, i)) { para.push(lines[i].trim()); i++; }
      out.push({ type: "paragraph", text: para.join("\n") });
    }
    return out;
  }

  function tokenize(text) {
    return parseBlocks(String(text ?? "").replace(/\r\n?/g, "\n").replace(/\t/g, "    ").split("\n"));
  }

  /* ---------- inline ---------- */

  const PUNCT = /[!-/:-@[-`{-~]/;
  const WORD = /[\p{L}\p{N}]/u;

  function safeHref(raw) {
    const href = String(raw ?? "").trim();
    if (!href || /[\u0000- \u007f-\u009f]/.test(href)) return null;
    if (/^https?:\/\/[^/?#]/i.test(href) || /^mailto:[^/]/i.test(href)) return href;
    return null;
  }

  // The matching closer for a delimiter run, or -1. Closers never follow whitespace.
  function findCloser(text, from, delim) {
    let at = text.indexOf(delim, from);
    while (at !== -1) {
      const before = text[at - 1];
      const after = text[at + delim.length];
      const intraword = delim[0] === "_" && after !== undefined && WORD.test(after);
      const doubled = delim.length === 1 && (text[at + 1] === delim || text[at - 1] === delim);
      if (at > from && before && !/\s/.test(before) && !intraword && !doubled) return at;
      at = text.indexOf(delim, at + delim.length);
    }
    return -1;
  }

  function parseInline(text, depth = 0) {
    const out = [];
    let buf = "";
    const flush = () => { if (buf) { out.push({ type: "text", text: buf }); buf = ""; } };
    const nested = (s) => (depth < MAX_DEPTH ? parseInline(s, depth + 1) : [{ type: "text", text: s }]);
    let i = 0;
    while (i < text.length) {
      const ch = text[i];

      if (ch === "\\" && i + 1 < text.length && PUNCT.test(text[i + 1])) { buf += text[i + 1]; i += 2; continue; }

      if (ch === "\n") { flush(); out.push({ type: "br" }); i++; continue; }

      if (ch === "`") {
        let n = 1;
        while (text[i + n] === "`") n++;
        const run = "`".repeat(n);
        let close = text.indexOf(run, i + n);
        while (close !== -1 && text[close + n] === "`") close = text.indexOf(run, close + n + 1);
        if (close !== -1) {
          let code = text.slice(i + n, close).replace(/\n/g, " ");
          if (/^ .*[^ ].* $/.test(code)) code = code.slice(1, -1);
          flush();
          out.push({ type: "code", text: code });
          i = close + n;
          continue;
        }
        buf += run; i += n; continue;
      }

      if ((ch === "*" || ch === "_" || ch === "~") && text[i + 1] === ch) {
        const delim = ch + ch;
        const prev = text[i - 1];
        const opens = text[i + 2] !== undefined && !/\s/.test(text[i + 2]) && !(ch === "_" && prev && WORD.test(prev));
        const close = opens ? findCloser(text, i + 2, delim) : -1;
        if (close !== -1) {
          flush();
          out.push({ type: ch === "~" ? "del" : "strong", children: nested(text.slice(i + 2, close)) });
          i = close + 2;
          continue;
        }
        buf += delim; i += 2; continue;
      }

      if (ch === "*" || ch === "_") {
        const prev = text[i - 1];
        const opens = text[i + 1] !== undefined && !/\s/.test(text[i + 1]) && !(ch === "_" && prev && WORD.test(prev));
        const close = opens ? findCloser(text, i + 1, ch) : -1;
        if (close !== -1) {
          flush();
          out.push({ type: "em", children: nested(text.slice(i + 1, close)) });
          i = close + 1;
          continue;
        }
        buf += ch; i++; continue;
      }

      if (ch === "[") {
        let level = 0;
        let end = -1;
        for (let j = i; j < text.length; j++) {
          if (text[j] === "\\") { j++; continue; }
          if (text[j] === "[") level++;
          else if (text[j] === "]" && --level === 0) { end = j; break; }
        }
        if (end !== -1 && text[end + 1] === "(") {
          let parens = 0;
          let stop = -1;
          for (let j = end + 1; j < text.length; j++) {
            if (text[j] === "(") parens++;
            else if (text[j] === ")" && --parens === 0) { stop = j; break; }
          }
          if (stop !== -1) {
            let target = text.slice(end + 2, stop).trim();
            const titled = /^(\S+)\s+["'(].*["')]$/.exec(target);
            if (titled) target = titled[1];
            if (target.startsWith("<") && target.endsWith(">")) target = target.slice(1, -1);
            const label = nested(text.slice(i + 1, end));
            const href = safeHref(target);
            flush();
            if (href) out.push({ type: "link", href, children: label });
            else out.push(...label);
            i = stop + 1;
            continue;
          }
        }
        buf += ch; i++; continue;
      }

      if (ch === "<") {
        const auto = /^<((?:https?:\/\/|mailto:)[^\s<>]+)>/i.exec(text.slice(i));
        if (auto && safeHref(auto[1])) {
          flush();
          out.push({ type: "link", href: auto[1], children: [{ type: "text", text: auto[1].replace(/^mailto:/i, "") }] });
          i += auto[0].length;
          continue;
        }
        buf += ch; i++; continue;
      }

      if ((ch === "h" || ch === "H") && !(i > 0 && WORD.test(text[i - 1]))) {
        const bare = /^https?:\/\/[^\s<>]+/i.exec(text.slice(i));
        if (bare) {
          let url = bare[0].replace(/[.,;:!?'"*_~]+$/, "");
          // Drop a closing parenthesis the URL did not open: "(see https://x.y)".
          while (url.endsWith(")") && (url.match(/\(/g) || []).length < (url.match(/\)/g) || []).length) url = url.slice(0, -1);
          if (safeHref(url)) {
            flush();
            out.push({ type: "link", href: url, children: [{ type: "text", text: url }] });
            i += url.length;
            continue;
          }
        }
      }

      buf += ch;
      i++;
    }
    flush();
    return out;
  }

  /* ---------- DOM ---------- */

  function el(doc, tag, className, text) {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function inlineNodes(doc, tokens) {
    const out = [];
    for (const t of tokens) {
      if (t.type === "text") out.push(doc.createTextNode(t.text));
      else if (t.type === "br") out.push(doc.createElement("br"));
      else if (t.type === "code") out.push(el(doc, "code", "md-code", t.text));
      else if (t.type === "link") {
        const a = el(doc, "a", "md-link");
        a.setAttribute("href", t.href);
        a.setAttribute("target", "_blank");
        a.setAttribute("rel", "noopener noreferrer");
        a.append(...inlineNodes(doc, t.children));
        out.push(a);
      } else {
        const node = doc.createElement(t.type === "strong" ? "strong" : t.type === "del" ? "del" : "em");
        node.append(...inlineNodes(doc, t.children));
        out.push(node);
      }
    }
    return out;
  }

  const inline = (doc, text) => inlineNodes(doc, parseInline(text));

  function copyText(text) {
    const nav = root.navigator;
    if (nav?.clipboard?.writeText) return nav.clipboard.writeText(text);
    return Promise.reject(new Error("Clipboard unavailable"));
  }

  function codeBlock(doc, token) {
    const wrap = el(doc, "div", "md-pre");
    const bar = el(doc, "div", "md-pre-bar");
    const lang = el(doc, "span", "md-pre-lang", token.lang || "text");
    const copy = el(doc, "button", "md-copy", "Copy");
    copy.setAttribute("type", "button");
    copy.setAttribute("aria-label", `Copy ${token.lang || "code"}`);
    copy.addEventListener("click", () => {
      copyText(token.text).then(
        () => { copy.textContent = "Copied"; copy.dataset.state = "done"; },
        () => { copy.textContent = "Copy failed"; copy.dataset.state = "failed"; },
      ).finally(() => setTimeout(() => { copy.textContent = "Copy"; delete copy.dataset.state; }, 1600));
    });
    bar.append(lang, copy);
    const pre = el(doc, "pre", "md-pre-body");
    pre.setAttribute("tabindex", "0"); // scrollable regions must be reachable by keyboard
    const code = el(doc, "code", token.lang ? `language-${token.lang.replace(/[^\w+-]/g, "")}` : "", token.text);
    pre.append(code);
    wrap.append(bar, pre);
    return wrap;
  }

  function blockNodes(doc, tokens, tight = false) {
    const out = [];
    for (const t of tokens) {
      switch (t.type) {
        case "paragraph": {
          if (tight) { out.push(...inline(doc, t.text)); break; }
          const p = el(doc, "p");
          p.append(...inline(doc, t.text));
          out.push(p);
          break;
        }
        case "heading": {
          // The page title is the h1; agent headings start one level below it.
          const h = el(doc, `h${Math.min(6, t.level + 1)}`, `md-h md-h${t.level}`);
          h.append(...inline(doc, t.text));
          out.push(h);
          break;
        }
        case "rule": out.push(el(doc, "hr")); break;
        case "code": out.push(codeBlock(doc, t)); break;
        case "quote": {
          const q = el(doc, "blockquote");
          q.append(...blockNodes(doc, t.children));
          out.push(q);
          break;
        }
        case "list": {
          const list = el(doc, t.ordered ? "ol" : "ul", t.items.some((it) => it.task !== null) ? "md-tasks" : "");
          if (t.ordered && t.start !== 1) list.setAttribute("start", String(t.start));
          for (const item of t.items) {
            const li = el(doc, "li");
            if (item.task !== null) {
              li.className = "md-task";
              const box = el(doc, "span", `md-check${item.task ? " is-done" : ""}`);
              box.setAttribute("role", "img");
              box.setAttribute("aria-label", item.task ? "Done" : "Not done");
              li.append(box);
            }
            const onlyText = !t.loose && item.children.length >= 1 && item.children[0].type === "paragraph";
            if (onlyText) {
              li.append(...blockNodes(doc, item.children.slice(0, 1), true));
              li.append(...blockNodes(doc, item.children.slice(1)));
            } else li.append(...blockNodes(doc, item.children));
            list.append(li);
          }
          out.push(list);
          break;
        }
        case "table": {
          const wrap = el(doc, "div", "md-table");
          wrap.setAttribute("tabindex", "0");
          const table = el(doc, "table");
          const thead = el(doc, "thead");
          const head = el(doc, "tr");
          t.header.forEach((cell, c) => {
            const th = el(doc, "th");
            th.setAttribute("scope", "col");
            if (t.align[c]) th.style.textAlign = t.align[c];
            th.append(...inline(doc, cell));
            head.append(th);
          });
          thead.append(head);
          const tbody = el(doc, "tbody");
          for (const row of t.rows) {
            const tr = el(doc, "tr");
            row.forEach((cell, c) => {
              const td = el(doc, "td");
              if (t.align[c]) td.style.textAlign = t.align[c];
              td.append(...inline(doc, cell));
              tr.append(td);
            });
            tbody.append(tr);
          }
          table.append(thead, tbody);
          wrap.append(table);
          out.push(wrap);
          break;
        }
        default: break;
      }
    }
    return out;
  }

  function render(text, doc = root.document) {
    return blockNodes(doc, tokenize(text));
  }

  function renderInto(container, text) {
    container.replaceChildren(...render(text, container.ownerDocument || root.document));
  }

  root.ChatMarkdown = { tokenize, parseInline, safeHref, render, renderInto };
})(typeof window !== "undefined" ? window : globalThis);
