import { childEnvironment } from "./child-env";
function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : {};
}
function json(value: string): unknown { try { return JSON.parse(value); } catch { return null; } }
export function accountEmail(value: unknown): string | null {
  const email = object(value).email;
  return typeof email === "string" && email.length > 0 && email.length <= 200 && !/[\x00-\x1f]/.test(email) ? email : null;
}
export async function readCodexIdentity(): Promise<string | null> {
  try { return accountEmail(object(await readCodexAccount()).account); } catch { return null; }
}
export async function readClaudeIdentity(): Promise<string | null> {
  try {
    const child = Bun.spawn(["claude", "auth", "status", "--json"], { stdin: "ignore", stdout: "pipe", stderr: "ignore", env: childEnvironment() });
    const timer = setTimeout(() => child.kill(9), 15_000);
    try {
      const data = object(json(await new Response(child.stdout).text()));
      return await child.exited === 0 && data.loggedIn === true ? accountEmail(data) : null;
    } finally { clearTimeout(timer); }
  } catch { return null; }
}

export async function readCodexAccount(): Promise<unknown> {
  const child = Bun.spawn(["codex", "app-server", "--stdio"], {
    env: childEnvironment(), stdin: "pipe", stdout: "pipe", stderr: "ignore",
  });
  const timer = setTimeout(() => child.kill(9), 15_000);
  const send = (value: unknown) => { child.stdin.write(JSON.stringify(value) + "\n"); child.stdin.flush(); };
  try {
    send({ id: 1, method: "initialize", params: { clientInfo: { name: "xcloud-sessions", version: "1" }, capabilities: {} } });
    const reader = child.stdout.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let bytes = 0;
    while (bytes < 128 * 1024) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      buffer += decoder.decode(value, { stream: true });
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const message = object(json(buffer.slice(0, newline)));
        buffer = buffer.slice(newline + 1);
        if (message.id === 1) {
          if (message.error) return null;
          send({ method: "initialized" });
          send({ id: 2, method: "account/read", params: { refreshToken: false } });
        }
        if (message.id === 2) return message.result ?? null;
      }
    }
    return null;
  } finally {
    clearTimeout(timer);
    child.stdin.end();
    child.kill();
    await child.exited;
  }
}
