/**
 * claude.ai browser login for the chat-deletion feature.
 * Writes progress to ~/.config/claude-browser/auth-status.json, polls
 * ~/.config/claude-browser/code.txt for the emailed verification code.
 * Run under xvfb-run (headed chromium — true headless trips Cloudflare).
 */
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

const DIR = path.join(process.env.HOME, ".config", "claude-browser");
const STATUS = path.join(DIR, "auth-status.json");
const CODE_FILE = path.join(DIR, "code.txt");
const EMAIL = (process.env.CAI_EMAIL || "").trim();

const setStatus = (state, message = "") =>
  fs.writeFileSync(STATUS, JSON.stringify({ state, message, at: Date.now() }), { mode: 0o600 });

(async () => {
  fs.mkdirSync(path.join(DIR, "profile"), { recursive: true, mode: 0o700 });
  try { fs.unlinkSync(CODE_FILE); } catch {}
  if (!EMAIL || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(EMAIL)) {
    setStatus("error", "Configure CAI_EMAIL before starting browser login.");
    process.exit(1);
  }
  setStatus("starting");
  const ctx = await chromium.launchPersistentContext(path.join(DIR, "profile"), {
    headless: false, viewport: { width: 1280, height: 900 },
    args: ["--disable-blink-features=AutomationControlled"],
  });
  const page = ctx.pages()[0] || (await ctx.newPage());
  await page.goto("https://claude.ai/login", { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(6000);

  if (!page.url().includes("login")) {
    setStatus("success", "Already signed in.");
    await ctx.close();
    return;
  }

  const email = page.locator('input[type="email"]').first();
  await email.waitFor({ timeout: 30000 });
  await email.fill(EMAIL);
  await page.waitForTimeout(500);
  await page.locator('button:has-text("email"), button[type="submit"]').first().click();
  await page.waitForTimeout(6000);
  setStatus("code_sent", `Code emailed to ${EMAIL}.`);

  let code = null;
  for (let i = 0; i < 450; i++) {
    if (fs.existsSync(CODE_FILE)) {
      code = fs.readFileSync(CODE_FILE, "utf8").trim();
      fs.unlinkSync(CODE_FILE);
      break;
    }
    await page.waitForTimeout(2000);
  }
  if (!code) { setStatus("error", "Timed out waiting for the code."); await ctx.close(); process.exit(1); }

  const codeInput = page.locator('input[type="text"], input[inputmode="numeric"], input[autocomplete="one-time-code"]').first();
  await codeInput.waitFor({ timeout: 15000 });
  await codeInput.fill(code);
  await page.waitForTimeout(800);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(9000);
  await page.goto("https://claude.ai/", { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(5000);
  const ok = !page.url().includes("login");
  setStatus(ok ? "success" : "error", ok ? "Signed in." : "Code rejected — try again.");
  await ctx.close();
  process.exit(ok ? 0 : 1);
})().catch(async (e) => { setStatus("error", e.message.slice(0, 200)); process.exit(1); });
