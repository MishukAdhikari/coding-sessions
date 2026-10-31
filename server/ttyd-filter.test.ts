import { test, expect } from "bun:test";
import { filterDownstream, filterUpstream } from "./ttyd-filter";

const E = "\x1b";
const asStr = (x: unknown): string => {
  if (typeof x === "string") return x;
  const u = x instanceof Uint8Array ? x : new Uint8Array(x as ArrayBuffer);
  let r = ""; for (const b of u) r += String.fromCharCode(b); return r;
};

test("downstream strips mouse-mode enables (string frame)", () => {
  expect(filterDownstream(`0${E}[?1006h${E}[?1000hhello`)).toBe(`0hello`);
  expect(filterDownstream(`0${E}[?1002;1003;1006hX`)).toBe(`0X`);
});

test("downstream keeps alt-screen and bracketed paste", () => {
  expect(filterDownstream(`0${E}[?1049h${E}[?2004htext`)).toBe(`0${E}[?1049h${E}[?2004htext`);
});

test("downstream leaves a combined mouse+altscreen set intact (no partial mangling)", () => {
  const in_ = `0${E}[?1049;1000htext`;
  expect(filterDownstream(in_)).toBe(in_);
});

test("downstream handles a binary (ArrayBuffer) frame and round-trips UTF-8 bytes", () => {
  const payload = `${E}[?1000h café`;
  const bytes = new Uint8Array([0x30, ...[...payload].map((c) => c.charCodeAt(0) & 0xff)]);
  expect(asStr(filterDownstream(bytes.buffer))).toBe("0 café");
});

test("downstream ignores non-output frames (set-title '1')", () => {
  expect(filterDownstream(`1${E}[?1000h`)).toBe(`1${E}[?1000h`);
});

test("upstream strips SGR mouse reports, keeps real input", () => {
  expect(filterUpstream(`0${E}[<0;22;1M`)).toBe(`0`);
  expect(filterUpstream(`0${E}[<35;10;5m`)).toBe(`0`);
  expect(filterUpstream(`0ls -la\r`)).toBe(`0ls -la\r`);
});

test("upstream strips legacy X10 mouse reports", () => {
  expect(filterUpstream(`0${E}[M !!`)).toBe(`0`);
});

test("a frame with nothing to strip returns the identical object", () => {
  const inp = `0just typing`;
  expect(filterDownstream(inp)).toBe(inp);
});

const AMBER = `${E}[1;38;5;214m`;

test("downstream recolours standalone bold and resets fg on bold-off", () => {
  expect(filterDownstream(`0${E}[1m/research${E}[22m ok`)).toBe(`0${AMBER}/research${E}[22;39m ok`);
  expect(filterDownstream(`0${E}[01mX`)).toBe(`0${AMBER}X`);
});

test("downstream leaves already-coloured bold untouched", () => {
  expect(filterDownstream(`0${E}[1;31mError${E}[0m`)).toBe(`0${E}[1;31mError${E}[0m`);
});

test("downstream recolour composes with mouse-enable stripping", () => {
  expect(filterDownstream(`0${E}[?1000h${E}[1m/commit${E}[22m`)).toBe(`0${AMBER}/commit${E}[22;39m`);
});

test("mouse passthrough keeps enables and reports but still recolours bold", () => {
  expect(filterDownstream(`0${E}[?1006h${E}[?1000hhello`, { mouse: true })).toBe(`0${E}[?1006h${E}[?1000hhello`);
  expect(filterDownstream(`0${E}[1m/cmd${E}[22m`, { mouse: true })).toBe(`0${E}[1;38;5;214m/cmd${E}[22;39m`);
  const report = `0${E}[<64;10;5M`;
  expect(filterUpstream(report, { mouse: true })).toBe(report);
  expect(filterUpstream(report)).toBe("0");
});

test("CS_TERM_MOUSE=off strips the mouse even where passthrough was asked for", () => {
  const prev = process.env.CS_TERM_MOUSE;
  process.env.CS_TERM_MOUSE = "off";
  try {
    expect(filterDownstream(`0${E}[?1000hx`, { mouse: true })).toBe("0x");
    expect(filterUpstream(`0${E}[<0;1;1M`, { mouse: true })).toBe("0");
  } finally {
    if (prev === undefined) delete process.env.CS_TERM_MOUSE; else process.env.CS_TERM_MOUSE = prev;
  }
});
