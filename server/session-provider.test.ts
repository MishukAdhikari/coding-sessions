import { expect, test } from "bun:test";
import {
  LAUNCH_PROTOCOL,
  PROVIDER_CAPABILITIES,
  SESSION_PROVIDERS,
  launchOptionsFromRequest,
  parseSessionProvider,
} from "./session-provider";

test("provider parsing is strict", () => {
  expect(parseSessionProvider("claude")).toBe("claude");
  expect(parseSessionProvider("codex")).toBe("codex");
  expect(parseSessionProvider("command-code")).toBe("command-code");
  expect(parseSessionProvider("Command-Code")).toBeNull();
  expect(parseSessionProvider("Claude")).toBeNull();
  expect(parseSessionProvider(" codex ")).toBeNull();
  expect(parseSessionProvider(undefined)).toBeNull();
});

test("legacy launch bodies default to Claude and preserve Remote Control defaults", () => {
  expect(launchOptionsFromRequest({})).toEqual({
    ok: true,
    provider: "claude",
    remoteControl: true,
  });
  expect(launchOptionsFromRequest({ remoteControl: false })).toEqual({
    ok: true,
    provider: "claude",
    remoteControl: false,
  });
});

test("Codex normalizes omitted Remote Control off and rejects Claude-only options", () => {
  expect(launchOptionsFromRequest({ provider: "codex" })).toEqual({
    ok: true,
    provider: "codex",
    remoteControl: false,
  });
  expect(launchOptionsFromRequest({ provider: "codex", remoteControl: true })).toEqual({
    ok: false,
    error: "Remote Control is only available for Claude sessions.",
  });
});

test("unknown or explicitly empty providers are rejected", () => {
  expect(launchOptionsFromRequest({ provider: "bogus" }).ok).toBe(false);
  expect(launchOptionsFromRequest({ provider: null }).ok).toBe(false);
});

test("capabilities describe the provider boundary from one matrix", () => {
  expect(LAUNCH_PROTOCOL).toBe(2);
  expect(SESSION_PROVIDERS).toEqual(["claude", "codex", "command-code"]);
  expect(PROVIDER_CAPABILITIES.claude).toMatchObject({
    displayName: "Claude",
    remoteControl: true,
    nativeChatUrl: true,
    chatDeletion: true,
    externalDiscovery: true,
    syncedLaunch: true,
    authentication: "setup-token",
  });
  expect(PROVIDER_CAPABILITIES.codex).toMatchObject({
    displayName: "Codex",
    remoteControl: false,
    nativeChatUrl: false,
    chatDeletion: false,
    externalDiscovery: false,
    syncedLaunch: false,
    authentication: "device-auth",
  });
  // Command Code reopens a conversation by id but publishes no hook, so it claims
  // exact resume and declines semantic status. Both halves matter to the UI.
  expect(PROVIDER_CAPABILITIES["command-code"]).toMatchObject({
    displayName: "Command Code",
    managedLaunch: true,
    freshWorkspace: true,
    webTerminal: true,
    semanticStatus: false,
    exactResume: true,
    remoteControl: false,
    nativeChatUrl: false,
    chatDeletion: false,
    externalDiscovery: false,
    syncedLaunch: false,
    authentication: "api-key",
  });
});

test("Command Code launches without Remote Control, and refuses to pretend otherwise", () => {
  expect(launchOptionsFromRequest({ provider: "command-code" })).toEqual({
    ok: true,
    provider: "command-code",
    remoteControl: false,
  });
  expect(launchOptionsFromRequest({ provider: "command-code", remoteControl: true })).toEqual({
    ok: false,
    error: "Remote Control is only available for Claude sessions.",
  });
});
