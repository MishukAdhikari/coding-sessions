/* A small DOM for the chat page tests: enough of Element, Text and Document for
 * chat-markdown.js, chat-view.js, chat.js and launch-mode.js, plus a parser for the
 * page's own static markup. Markup setters throw, so a test fails if any code path
 * writes HTML. */

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr", "path"]);

class Text {
  constructor(text, doc) { this.nodeType = 3; this.data = String(text); this.parentNode = null; this.ownerDocument = doc; }
  get textContent() { return this.data; }
  set textContent(v) { this.data = String(v); }
}

class Element {
  constructor(tag, doc) {
    this.nodeType = 1;
    this.localName = String(tag).toLowerCase();
    this.tagName = this.localName.toUpperCase();
    this.ownerDocument = doc;
    this.parentNode = null;
    this.childNodes = [];
    this.attributes = new Map();
    this.dataset = {};
    this.style = {};
    this.listeners = {};
    this.hidden = false;
    this.disabled = false;
    this.checked = false;
    this.open = false;
    this.value = "";
    this.scrollTop = 0;
    this.scrollHeight = 0;
    this.clientHeight = 0;
  }
  get children() { return this.childNodes.filter((n) => n.nodeType === 1); }
  get className() { return this.attributes.get("class") ?? ""; }
  set className(v) { this.attributes.set("class", String(v)); }
  get id() { return this.attributes.get("id") ?? ""; }
  set id(v) { this.attributes.set("id", String(v)); }
  get classList() {
    const self = this;
    const list = () => self.className.split(/\s+/).filter(Boolean);
    return {
      contains: (c) => list().includes(c),
      add: (...cs) => { self.className = [...new Set([...list(), ...cs])].join(" "); },
      remove: (...cs) => { self.className = list().filter((c) => !cs.includes(c)).join(" "); },
      toggle: (c, force) => {
        const on = force === undefined ? !list().includes(c) : !!force;
        if (on) self.classList.add(c); else self.classList.remove(c);
        return on;
      },
    };
  }
  get textContent() { return this.childNodes.map((n) => n.textContent).join(""); }
  set textContent(v) { this.replaceChildren(...(v === "" || v == null ? [] : [String(v)])); }
  set innerHTML(_) { throw new Error("innerHTML must not be used"); }
  get innerHTML() { throw new Error("innerHTML must not be read"); }
  set outerHTML(_) { throw new Error("outerHTML must not be used"); }
  insertAdjacentHTML() { throw new Error("insertAdjacentHTML must not be used"); }

  adopt(node) {
    const n = typeof node === "string" ? new Text(node, this.ownerDocument) : node;
    if (n.parentNode) n.parentNode.childNodes = n.parentNode.childNodes.filter((c) => c !== n);
    n.parentNode = this;
    return n;
  }
  append(...nodes) { for (const node of nodes) this.childNodes.push(this.adopt(node)); }
  appendChild(node) { this.append(node); return node; }
  prepend(...nodes) { const adopted = nodes.map((n) => this.adopt(n)); this.childNodes.unshift(...adopted); }
  replaceChildren(...nodes) {
    for (const old of this.childNodes) old.parentNode = null;
    this.childNodes = [];
    this.append(...nodes);
  }
  replaceWith(node) {
    const parent = this.parentNode;
    if (!parent) return;
    const n = parent.adopt(node); // detaches n from wherever it was first
    parent.childNodes[parent.childNodes.indexOf(this)] = n;
    this.parentNode = null;
  }
  remove() { if (this.parentNode) { this.parentNode.childNodes = this.parentNode.childNodes.filter((c) => c !== this); this.parentNode = null; } }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
    if (name === "hidden") this.hidden = true;
    if (name === "disabled") this.disabled = true;
    if (name === "checked") this.checked = true;
    if (name === "open") this.open = true;
    if (name.startsWith("data-")) this.dataset[name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = String(value);
  }
  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
  hasAttribute(name) { return this.attributes.has(name); }
  removeAttribute(name) { this.attributes.delete(name); }

  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
  removeEventListener(type, fn) { this.listeners[type] = (this.listeners[type] || []).filter((f) => f !== fn); }
  dispatch(type, init = {}) {
    const event = { type, target: this, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...init };
    for (const fn of this.listeners[type] || []) fn(event);
    return event;
  }
  click() { if (!this.disabled) this.dispatch("click"); }
  focus() { this.ownerDocument.activeElement = this; }
  scrollTo({ top } = {}) { this.scrollTop = top ?? this.scrollTop; }

  *walk() { for (const c of this.children) { yield c; yield* c.walk(); } }
  matches(selector) { return selector.split(",").some((s) => matchCompound(this, s.trim())); }
  querySelectorAll(selector) {
    const parts = selector.trim().split(/\s+/);
    let scope = [this];
    for (const part of parts) {
      const next = [];
      for (const s of scope) for (const el of s.walk()) if (el.matches(part) && !next.includes(el)) next.push(el);
      scope = next;
    }
    return scope;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  contains(node) { for (let n = node; n; n = n.parentNode) if (n === this) return true; return false; }
}

function matchCompound(el, selector) {
  const m = selector.match(/^([a-z0-9-]*)((?:[.#][\w-]+|\[[^\]]+\]|:not\(\[hidden\]\))*)$/i);
  if (!m) throw new Error(`Unsupported selector: ${selector}`);
  if (m[1] && el.localName !== m[1].toLowerCase()) return false;
  for (const part of m[2].match(/[.#][\w-]+|\[[^\]]+\]|:not\(\[hidden\]\)/g) || []) {
    if (part.startsWith(".") && !el.classList.contains(part.slice(1))) return false;
    if (part.startsWith("#") && el.id !== part.slice(1)) return false;
    if (part === ":not([hidden])" && el.hidden) return false;
    if (part.startsWith("[")) {
      const [name, raw] = part.slice(1, -1).split("=");
      if (raw === undefined ? !el.hasAttribute(name) : el.getAttribute(name) !== raw.replace(/^["']|["']$/g, "")) return false;
    }
  }
  return true;
}

export function createDocument() {
  const doc = {
    title: "",
    hidden: false,
    activeElement: null,
    listeners: {},
    createElement: (tag) => new Element(tag, doc),
    createElementNS: (_ns, tag) => new Element(tag, doc),
    createTextNode: (text) => new Text(text, doc),
    addEventListener(type, fn) { (doc.listeners[type] ??= []).push(fn); },
    getElementById: (id) => (doc.documentElement.id === id ? doc.documentElement : doc.documentElement.querySelector(`#${id}`)),
    querySelector: (s) => doc.documentElement.querySelector(s),
    querySelectorAll: (s) => doc.documentElement.querySelectorAll(s),
    write() { throw new Error("document.write must not be used"); },
  };
  doc.documentElement = new Element("html", doc);
  doc.body = new Element("body", doc);
  doc.documentElement.append(doc.body);
  return doc;
}

const decode = (s) => s.replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (_, e) => ({ amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", nbsp: " " })[e]);

/** Builds the <body> of a static page (the repo's own markup) into the document. */
export function loadBody(doc, html) {
  const body = html.slice(html.indexOf("<body"), html.lastIndexOf("</body>"));
  const stack = [doc.body];
  const re = /<!--[\s\S]*?-->|<script\b[\s\S]*?<\/script>|<\/([a-z0-9-]+)\s*>|<([a-z0-9-]+)((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>|([^<]+)/gi;
  let first = true;
  for (const m of body.matchAll(re)) {
    if (first) { first = false; if (m[2]?.toLowerCase() === "body") { applyAttrs(doc.body, m[3]); continue; } }
    const top = stack[stack.length - 1];
    if (m[5] !== undefined) { if (m[5].trim()) top.append(decode(m[5].replace(/\s+/g, " "))); continue; }
    if (m[1]) { const tag = m[1].toLowerCase(); for (let i = stack.length - 1; i > 0; i--) if (stack[i].localName === tag) { stack.length = i; break; } continue; }
    if (!m[2]) continue;
    const el = doc.createElement(m[2]);
    applyAttrs(el, m[3]);
    top.append(el);
    if (!VOID.has(el.localName) && !m[4]) stack.push(el);
  }
  return doc;
}

function applyAttrs(el, raw = "") {
  for (const a of raw.matchAll(/([^\s=>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
    el.setAttribute(a[1], decode(a[2] ?? a[3] ?? a[4] ?? ""));
  }
}

/** All text under a node, whitespace collapsed. */
export const text = (node) => String(node?.textContent ?? "").replace(/\s+/g, " ").trim();
