import { expect, test } from "bun:test";
import { cleanLabel, createCliLogins, handleCliLoginRoute, normalizeUserCode, type CliLoginRouteDependencies } from "./cli-login";

const ORIGIN = "https://sessions.example.com";

function setup(limited: (key: string) => boolean = () => false) {
  let clock = 1_000_000;
  const logins = createCliLogins({ now: () => clock });
  const minted: string[] = [];
  const deps: CliLoginRouteDependencies = {
    origin: ORIGIN, cookieName: "cs",
    checkBrowserSession: (token) => token === "good",
    logins,
    mintToken: (label) => { minted.push(label); return `cs_minted_${minted.length}`; },
    rateLimited: (key) => limited(key),
    clientIp: () => "203.0.113.9",
  };
  const call = (path: string, init: { method?: string; body?: unknown; cookie?: string | null; origin?: string | null; bearer?: boolean } = {}) => {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (init.cookie !== null && !init.bearer) headers.cookie = `cs=${init.cookie ?? "good"}`;
    if (init.bearer) headers.authorization = "Bearer cs_token";
    if (init.origin !== null) headers.origin = init.origin ?? ORIGIN;
    return handleCliLoginRoute(new Request(`${ORIGIN}${path}`, {
      method: init.method ?? "POST", headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    }), deps);
  };
  // cs sends neither a cookie nor an Origin.
  const cs = (path: string, body: unknown) => call(path, { body, cookie: null, origin: null });
  const start = async () => (await (await cs("/api/cli-login/start", { label: "laptop" }))!.json()) as any;
  return { call, cs, start, minted, tick: (ms: number) => { clock += ms; } };
}

test("unrelated paths fall through", async () => {
  const { call } = setup();
  expect(await call("/api/cli-tokens")).toBeNull();
});

test("start, approve in the browser, then poll hands over the token exactly once", async () => {
  const { call, cs, start, minted } = setup();
  const started = await start();
  expect(started.user_code).toMatch(/^[A-Z]{4}-[A-Z]{4}$/);
  expect(started.verify_url).toBe(`${ORIGIN}/#cli-login=${started.user_code}`);
  expect(started).toMatchObject({ expires_in: 600, interval: 2 });
  expect(started.verify_url).not.toContain(started.code);

  expect(await (await cs("/api/cli-login/poll", { code: started.code }))!.json()).toEqual({ status: "pending" });
  const shown: any = await (await call(`/api/cli-login/request?user_code=${started.user_code.toLowerCase()}`, { method: "GET" }))!.json();
  expect(shown.label).toBe("laptop");

  expect((await call("/api/cli-login/approve", { body: { user_code: started.user_code } }))!.status).toBe(200);
  const got: any = await (await cs("/api/cli-login/poll", { code: started.code }))!.json();
  expect(got).toEqual({ status: "approved", token: "cs_minted_1" });
  expect(minted).toEqual(["cs on laptop"]);

  const again = await cs("/api/cli-login/poll", { code: started.code });
  expect(again!.status).toBe(410);
  expect(minted).toHaveLength(1);
  expect((await call("/api/cli-login/approve", { body: { user_code: started.user_code } }))!.status).toBe(404);
});

test("deny tells cs once and mints nothing", async () => {
  const { call, cs, start, minted } = setup();
  const started = await start();
  expect((await call("/api/cli-login/deny", { body: { user_code: started.user_code } }))!.status).toBe(200);
  const res = await cs("/api/cli-login/poll", { code: started.code });
  expect(res!.status).toBe(403);
  expect(((await res!.json()) as any).status).toBe("denied");
  expect((await cs("/api/cli-login/poll", { code: started.code }))!.status).toBe(410);
  expect(minted).toHaveLength(0);
});

test("codes expire after ten minutes, even once approved", async () => {
  const { call, cs, start, tick, minted } = setup();
  const a = await start();
  tick(10 * 60 * 1000 + 1);
  expect((await call("/api/cli-login/approve", { body: { user_code: a.user_code } }))!.status).toBe(404);
  expect((await cs("/api/cli-login/poll", { code: a.code }))!.status).toBe(410);

  const b = await start();
  await call("/api/cli-login/approve", { body: { user_code: b.user_code } });
  tick(10 * 60 * 1000 + 1);
  expect((await cs("/api/cli-login/poll", { code: b.code }))!.status).toBe(410);
  expect(minted).toHaveLength(0);
});

test("a wrong code or user code gets nothing", async () => {
  const { call, cs, start } = setup();
  const started = await start();
  expect((await cs("/api/cli-login/poll", { code: "nope" }))!.status).toBe(410);
  expect((await cs("/api/cli-login/poll", { code: started.user_code }))!.status).toBe(410);
  expect((await call("/api/cli-login/approve", { body: { user_code: "BBBB-BBBB" } }))!.status).toBe(404);
  // The polling code is not a user code either.
  expect((await call("/api/cli-login/approve", { body: { user_code: started.code } }))!.status).toBe(404);
  expect(await (await cs("/api/cli-login/poll", { code: started.code }))!.json()).toEqual({ status: "pending" });
});

test("approval needs a signed-in browser on the app's own origin", async () => {
  const { call, cs, start, minted } = setup();
  const started = await start();
  const body = { user_code: started.user_code };
  expect((await call("/api/cli-login/approve", { body, bearer: true }))!.status).toBe(401);
  expect((await call("/api/cli-login/approve", { body, cookie: "stolen" }))!.status).toBe(401);
  expect((await call("/api/cli-login/approve", { body, origin: "https://evil.example" }))!.status).toBe(403);
  expect((await call("/api/cli-login/approve", { body, origin: null }))!.status).toBe(403);
  expect((await call(`/api/cli-login/request?user_code=${started.user_code}`, { method: "GET", bearer: true }))!.status).toBe(401);
  expect(await (await cs("/api/cli-login/poll", { code: started.code }))!.json()).toEqual({ status: "pending" });
  expect(minted).toHaveLength(0);
});

test("starting and polling are rate-limited per address", async () => {
  const { cs } = setup((key) => key.startsWith("cli-login-start:203.0.113.9"));
  expect((await cs("/api/cli-login/start", { label: "x" }))!.status).toBe(429);
  expect((await cs("/api/cli-login/poll", { code: "x" }))!.status).toBe(410);
});

test("user codes and labels are normalised", () => {
  expect(normalizeUserCode(" bcdf-ghjk ")).toBe("BCDFGHJK");
  expect(normalizeUserCode(42)).toBe("");
  expect(cleanLabel("my<script>mac\n")).toBe("myscriptmac");
  expect(cleanLabel("")).toBe("a computer");
  expect(cleanLabel("x".repeat(80))).toHaveLength(40);
});
