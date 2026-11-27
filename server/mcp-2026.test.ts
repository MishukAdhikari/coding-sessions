import { expect, test } from "bun:test";
import { checkModernRequest, decodeHeaderValue, encodeHeaderValue, isModernMessage, modernHeaders } from "./mcp-2026";

const _meta = { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {} };

test("only a request naming the 2026 protocol version in _meta is modern; initialize never is", () => {
  expect(isModernMessage({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta } })).toBe(true);
  expect(isModernMessage({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: { progressToken: 1 } } })).toBe(false);
  expect(isModernMessage({ jsonrpc: "2.0", id: 1, method: "tools/list" })).toBe(false);
  expect(isModernMessage({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", _meta } })).toBe(false);
});

test("headers derived for the bridge pass the endpoint's checks, base64-encoding what is not plain ASCII", () => {
  const msg = { jsonrpc: "2.0", id: 1, method: "resources/read", params: { uri: "file:///tmp/naïve report.txt", _meta } };
  const headers = modernHeaders(msg);
  expect(headers["mcp-name"]).toStartWith("=?base64?");
  expect(decodeHeaderValue(headers["mcp-name"]!)).toBe("file:///tmp/naïve report.txt");
  expect(checkModernRequest(msg, new Headers(headers), [])).toBeNull();
  expect(encodeHeaderValue("tools/call")).toBe("tools/call");
  expect(encodeHeaderValue(" padded")).toStartWith("=?base64?");
  expect(modernHeaders({ method: "tools/list", params: { _meta } })).toEqual({ "mcp-protocol-version": "2026-07-28", "mcp-method": "tools/list" });
});
