import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pasteBytes, screenPasteArgs, settleMs } from "./session-io";

test("screen gets the text from its paste buffer, never through stuff", () => {
  expect(screenPasteArgs("cs-demo", "/tmp/cs-paste-x/text")).toEqual(
    ["screen", "-S", "cs-demo", "-p", "0", "-X", "eval", "readbuf /tmp/cs-paste-x/text", "paste ."]);
});

test("a long message gets longer to land before Enter, within bounds", () => {
  expect(settleMs("")).toBe(0);
  expect(settleMs("hi")).toBe(250);
  expect(settleMs("x".repeat(4000))).toBe(350);
  expect(settleMs("x".repeat(1_000_000))).toBe(1750);
});

const screenBin = Bun.which("screen");
const python = Bun.which("python3");

test.skipIf(!screenBin || !python)("text reaches a detached screen session byte for byte: ^, $, backslash, UTF-8 and 20 KB", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cs-io-"));
  const name = `cs-iotest-${process.pid}`;
  const out = join(dir, "out.bin");
  const recorder = join(dir, "rec.py");
  writeFileSync(recorder, [
    "import sys, os, tty",
    "tty.setraw(0)",
    "f = open(sys.argv[1], 'ab', buffering=0)",
    "while True:",
    "    b = os.read(0, 65536)",
    "    if not b: break",
    "    f.write(b)",
  ].join("\n"));
  try {
    Bun.spawnSync(["screen", "-dmS", name, python!, recorder, out]);
    await Bun.sleep(500);
    const text = `a^b ^C $HOME \${PATH} back\\slash আমি 🙂 ${"L".repeat(20_000)} end`;
    const file = join(dir, "text");
    writeFileSync(file, pasteBytes(text));
    const r = Bun.spawnSync(screenPasteArgs(name, file));
    expect(r.exitCode).toBe(0);
    let got = "";
    for (let i = 0; i < 40 && got.length < Buffer.byteLength(text); i++) {
      await Bun.sleep(100);
      try { got = readFileSync(out, "utf8"); } catch {}
    }
    expect(got).toBe(text);
  } finally {
    Bun.spawnSync(["screen", "-S", name, "-X", "quit"]);
    rmSync(dir, { recursive: true, force: true });
  }
});
