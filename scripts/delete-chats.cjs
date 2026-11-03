/**
 * Delete claude.ai chats (Claude Code sessions) by session id.
 * Usage: node delete-chats.js session_x,session_y
 * Opens the saved authed profile, calls the same API the web UI uses.
 * Prints one JSON line per id: {"id":..., "ok":bool, "status":..., "note":...}
 * Prints {"auth":"expired"} if the profile is logged out.
 * Run under xvfb-run (headed chromium — true headless trips Cloudflare).
 */
const { chromium } = require("playwright");
const path = require("path");

const DIR = path.join(process.env.HOME, ".config", "claude-browser");
const IDS = (process.argv[2] || "").split(",").filter((s) => /^session_[A-Za-z0-9]+$/.test(s));

(async () => {
  if (!IDS.length) { console.log(JSON.stringify({ error: "no ids" })); process.exit(1); }
  const ctx = await chromium.launchPersistentContext(path.join(DIR, "profile"), {
    headless: false, viewport: { width: 1280, height: 900 },
    args: ["--disable-blink-features=AutomationControlled"],
  });
  const page = ctx.pages()[0] || (await ctx.newPage());
  await page.goto("https://claude.ai/code", { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(7000);
  if (page.url().includes("login")) {
    console.log(JSON.stringify({ auth: "expired" }));
    await ctx.close();
    process.exit(2);
  }
  for (const id of IDS) {
    const res = await page.evaluate(async (sid) => {
      const org = (document.cookie.match(/lastActiveOrg=([\w-]+)/) || [])[1] || "";
      const r = await fetch(`https://claude.ai/v1/sessions/${sid}`, {
        method: "DELETE",
        credentials: "include",
        headers: {
          "anthropic-client-platform": "web_claude_ai",
          "anthropic-version": "2023-06-01",
          "anthropic-client-feature": "ccr",
          "anthropic-client-version": "1.0.0",
          "x-organization-uuid": org,
          "content-type": "application/json",
          accept: "application/json",
        },
      });
      const body = (await r.text()).slice(0, 200);
      return { status: r.status, body };
    }, id).catch((e) => ({ status: 0, body: e.message }));
    const gone = res.body.includes("session_deleted");
    const already = res.status === 404 && res.body.trim().startsWith("{");
    console.log(JSON.stringify({ id, ok: gone || already, status: res.status, note: gone ? "deleted" : already ? "already gone" : res.body.slice(0, 80) }));
  }
  await ctx.close();
})().catch((e) => { console.log(JSON.stringify({ error: e.message.slice(0, 200) })); process.exit(1); });
