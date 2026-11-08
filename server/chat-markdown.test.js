import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { createDocument, text } from "./chat-test-dom.js";

const source = readFileSync(new URL("../public/chat-markdown.js", import.meta.url), "utf8");

function load(clipboard) {
  const document = createDocument();
  const timers = [];
  const context = { document, navigator: clipboard ? { clipboard } : {}, setTimeout: (fn) => { timers.push(fn); return timers.length; } };
  context.window = context;
  runInNewContext(source, context);
  const render = (markdown) => {
    const root = document.createElement("div");
    context.ChatMarkdown.renderInto(root, markdown);
    return root;
  };
  return { md: context.ChatMarkdown, render, timers };
}

test("an HTML tag in agent text stays literal text", () => {
  const { render } = load();
  const root = render("Look: <img src=x onerror=alert(1)>");
  expect(root.querySelectorAll("img")).toHaveLength(0);
  expect(text(root)).toBe("Look: <img src=x onerror=alert(1)>");
});

test("raw HTML blocks render as text, never as elements", () => {
  const { render } = load();
  const root = render('<script>steal()</script>\n\n<div onclick="x()">hi</div>\n\n<a href="javascript:alert(1)">go</a>');
  for (const tag of ["script", "div", "a"]) expect(root.querySelectorAll(tag)).toHaveLength(0);
  expect(text(root)).toContain("<script>steal()</script>");
  expect(text(root)).toContain('<div onclick="x()">hi</div>');
});

test("a javascript: link renders as its label, not an anchor", () => {
  const { render } = load();
  for (const href of ["javascript:alert(1)", "JaVaScRiPt:alert(1)", "data:text/html,<b>x</b>", "vbscript:msgbox(1)"]) {
    const root = render(`[click me](${href})`);
    expect(root.querySelectorAll("a")).toHaveLength(0);
    expect(text(root)).toContain("click me");
  }
});

test("http, https and mailto links open safely in a new tab", () => {
  const { render, md } = load();
  const root = render("See [the docs](https://example.com/a?b=1) or <mailto:ops@example.com>, and http://example.org/x.");
  const links = root.querySelectorAll("a");
  expect(links.map((a) => a.getAttribute("href"))).toEqual(["https://example.com/a?b=1", "mailto:ops@example.com", "http://example.org/x"]);
  for (const a of links) {
    expect(a.getAttribute("rel")).toBe("noopener noreferrer");
    expect(a.getAttribute("target")).toBe("_blank");
  }
  expect(md.safeHref("javascript:alert(1)")).toBeNull();
  expect(md.safeHref("https://example.com")).toBe("https://example.com");
});

test("a three-column table builds a table with three header cells", () => {
  const { render } = load();
  const root = render("| File | Lines | Status |\n|:-----|------:|:------:|\n| a.ts | 12 | ok |\n| b.ts | 3 | <b>bad</b> |");
  const table = root.querySelector("table");
  expect(table).not.toBeNull();
  const ths = table.querySelectorAll("th");
  expect(ths.map((th) => text(th))).toEqual(["File", "Lines", "Status"]);
  expect(ths.every((th) => th.getAttribute("scope") === "col")).toBe(true);
  expect(ths.map((th) => th.style.textAlign)).toEqual(["left", "right", "center"]);
  expect(table.querySelectorAll("tbody tr")).toHaveLength(2);
  expect(table.querySelectorAll("b")).toHaveLength(0);
  expect(text(table.querySelectorAll("td")[5])).toBe("<b>bad</b>");
});

test("fenced code gets a language label and a Copy button that copies the exact code", async () => {
  const copied = [];
  const { render, timers } = load({ writeText: async (value) => { copied.push(value); } });
  const code = "const a = 1 < 2;\nconsole.log(`<b>${a}</b>`);";
  const root = render(`Before\n\n\`\`\`ts\n${code}\n\`\`\`\n\nAfter`);
  const block = root.querySelector(".md-pre");
  expect(text(block.querySelector(".md-pre-lang"))).toBe("ts");
  const pre = block.querySelector("pre");
  expect(pre.querySelector("code").textContent).toBe(code);
  expect(pre.getAttribute("tabindex")).toBe("0");
  const copy = block.querySelector("button");
  expect(copy.textContent).toBe("Copy");
  expect(copy.getAttribute("type")).toBe("button");
  copy.click();
  await new Promise((r) => setTimeout(r, 0));
  expect(copied).toEqual([code]);
  expect(copy.textContent).toBe("Copied");
  timers.forEach((fn) => fn());
  expect(copy.textContent).toBe("Copy");
});

test("inline code stays inline, inside its paragraph", () => {
  const { render } = load();
  const root = render("Run `bun test <file>` now.");
  expect(root.querySelectorAll("pre")).toHaveLength(0);
  const p = root.querySelector("p");
  expect(p.querySelector("code").textContent).toBe("bun test <file>");
  expect(text(p)).toBe("Run bun test <file> now.");
});

test("an unclosed fence still renders as code while it streams", () => {
  const { render } = load();
  const root = render("```python\nprint('hi')");
  expect(root.querySelector("pre code").textContent).toBe("print('hi')");
  expect(text(root.querySelector(".md-pre-lang"))).toBe("python");
});

test("headings, lists, task lists and quotes build their elements", () => {
  const { render } = load();
  const root = render("# Title\n\n- one\n- **two**\n\n1. first\n2. second\n\n- [x] done\n- [ ] todo\n\n> quoted");
  expect(text(root.querySelector("h2"))).toBe("Title"); // the page owns h1
  expect(root.querySelectorAll("ul li").length).toBeGreaterThanOrEqual(2);
  expect(text(root.querySelector("strong"))).toBe("two");
  expect(root.querySelectorAll("ol li")).toHaveLength(2);
  expect(root.querySelectorAll(".md-check")).toHaveLength(2);
  expect(root.querySelector(".md-check.is-done").getAttribute("aria-label")).toBe("Done");
  expect(text(root.querySelector("blockquote"))).toBe("quoted");
});
