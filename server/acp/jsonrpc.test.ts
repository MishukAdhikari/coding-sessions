import { describe, expect, test } from "bun:test";
import { createLineFramer, createPeer, rpcError } from "./jsonrpc";

const enc = (s: string) => new TextEncoder().encode(s);

describe("line framing", () => {
  test("messages split across chunks frame into whole lines", () => {
    const framer = createLineFramer(1024);
    const out = [
      ...framer.push(enc('{"a":1}\n{"b"')),
      ...framer.push(enc(':2}')),
      ...framer.push(enc('\r\n')),
    ];
    expect(out.map((l) => JSON.parse(l))).toEqual([{ a: 1 }, { b: 2 }]);
  });

  test("an oversized line is dropped and reported, and later lines still parse", () => {
    const sizes: number[] = [];
    const framer = createLineFramer(16, (n) => sizes.push(n));
    const out = framer.push(enc(`${"x".repeat(40)}\n{"ok":true}\n`));
    expect(out).toEqual(['{"ok":true}']);
    expect(sizes).toEqual([40]);
  });

  test("an oversized line arriving in pieces is skipped through its newline", () => {
    const sizes: number[] = [];
    const framer = createLineFramer(16, (n) => sizes.push(n));
    expect(framer.push(enc("y".repeat(20)))).toEqual([]);
    expect(framer.push(enc("yyyy\n{\"n\":1}\n"))).toEqual(['{"n":1}']);
    expect(sizes.length).toBe(1);
  });
});

describe("peer", () => {
  function pair() {
    const aOut: string[] = [];
    const bOut: string[] = [];
    const a = createPeer({ write: (l) => aOut.push(l) });
    const b = createPeer({
      write: (l) => bOut.push(l),
      onRequest: (method, params) => {
        if (method === "echo") return params;
        throw rpcError(-32000, "nope");
      },
    });
    const pump = async () => {
      while (aOut.length || bOut.length) {
        for (const l of aOut.splice(0)) b.handleLine(l);
        await Promise.resolve();
        for (const l of bOut.splice(0)) a.handleLine(l);
        await Promise.resolve();
      }
    };
    return { a, b, pump };
  }

  test("a response resolves the request with the matching id", async () => {
    const { a, pump } = pair();
    const p = a.request("echo", { x: 1 });
    await pump();
    expect(await p).toEqual({ x: 1 });
  });

  test("an error response rejects with the error code", async () => {
    const { a, pump } = pair();
    const p = a.request("boom");
    await pump();
    await expect(p).rejects.toMatchObject({ rpc: { code: -32000, message: "nope" } });
  });

  test("unknown ids, malformed lines and non-2.0 messages are ignored", () => {
    const out: string[] = [];
    const peer = createPeer({ write: (l) => out.push(l) });
    peer.handleLine("not json");
    peer.handleLine('{"jsonrpc":"1.0","id":0,"result":1}');
    peer.handleLine('{"jsonrpc":"2.0","id":99,"result":1}');
    expect(out).toEqual([]);
    expect(peer.pendingCount).toBe(0);
  });

  test("notifications reach the handler and get no reply", () => {
    const out: string[] = [];
    const seen: unknown[] = [];
    const peer = createPeer({ write: (l) => out.push(l), onNotification: (m, p) => seen.push([m, p]) });
    peer.handleLine('{"jsonrpc":"2.0","method":"session/update","params":{"x":1}}');
    expect(seen).toEqual([["session/update", { x: 1 }]]);
    expect(out).toEqual([]);
  });

  test("close rejects everything still waiting", async () => {
    const peer = createPeer({ write: () => {} });
    const p = peer.request("slow");
    peer.close("agent exited");
    await expect(p).rejects.toThrow("agent exited");
  });
});
