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
const LOG_FILE = path.join(DIR, "login.log");
const SHOT_FILE = path.join(DIR, "last-failure.png");
// Live view: when claude.ai asks for a human check, the person solves it from the PWA sheet.
// The script streams the page to LIVE_FILE and replays their taps and drags from INPUT_FILE.
const LIVE_FILE = path.join(DIR, "live.jpg");
const INPUT_FILE = path.join(DIR, "input.jsonl");
const VIEW = { width: 1280, height: 900 };
const CHALLENGE = /captcha|arkoselabs|funcaptcha|challenges\.cloudflare/i;
const EMAIL = (process.env.CAI_EMAIL || "").trim();

const setStatus = (state, message = "") => {
  fs.writeFileSync(STATUS, JSON.stringify({ state, message, at: Date.now() }), { mode: 0o600 });
  log(`status ${state}${message ? `: ${message}` : ""}`);
};
// Step log for diagnosing failed sign-ins. Never write the code itself here.
const log = (line) => { try { fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${line}\n`, { mode: 0o600 }); } catch {} };
let page = null;
async function recordFailure(reason, shot = SHOT_FILE) {
  log(`failure: ${reason}`);
  if (!page) return;
  log(`url: ${page.url()}`);
  const text = await page.locator("body").innerText({ timeout: 3000 }).catch(() => "");
  log(`page text: ${text.replace(/\s+/g, " ").slice(0, 600)}`);
  await page.screenshot({ path: shot }).catch(() => {});
}
const CODE_INPUT = 'input[autocomplete="one-time-code"]:visible, input[inputmode="numeric"]:visible, input[type="text"]:visible, input:not([type]):visible';
const REJECTED = /invalid|incorrect|expired|wrong code/i;

let clip = null; // the part of the page the live view shows (the challenge, when found)

async function findChallenge() {
  let best = null;
  for (const frame of page.frames()) {
    if (!CHALLENGE.test(frame.url())) continue;
    const box = await frame.frameElement().then((el) => el.boundingBox()).catch(() => null);
    if (box && box.width > 40 && box.height > 40 && (!best || box.width * box.height > best.width * best.height)) best = box;
  }
  if (!best) return null;
  const pad = 12;
  const x = Math.max(0, best.x - pad), y = Math.max(0, best.y - pad);
  return { x, y, width: Math.min(VIEW.width - x, best.width + pad * 2), height: Math.min(VIEW.height - y, best.height + pad * 2) };
}

async function liveFrame() {
  clip = await findChallenge();
  const shot = await page.screenshot({ type: "jpeg", quality: 70, ...(clip ? { clip } : {}) }).catch(() => null);
  if (!shot) return;
  fs.writeFileSync(`${LIVE_FILE}.tmp`, shot, { mode: 0o600 });
  fs.renameSync(`${LIVE_FILE}.tmp`, LIVE_FILE);
}

/** Replay queued taps and drags; coordinates are fractions of the image the person saw. */
async function applyInput() {
  const work = `${INPUT_FILE}.work`;
  let lines = [];
  try {
    fs.renameSync(INPUT_FILE, work);
    lines = fs.readFileSync(work, "utf8").split("\n").filter(Boolean);
    fs.unlinkSync(work);
  } catch { return; }
  const area = clip || { x: 0, y: 0, ...VIEW };
  const at = (fx, fy) => [area.x + fx * area.width, area.y + fy * area.height];
  for (const line of lines) {
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    if (ev.type === "click") {
      await page.mouse.click(...at(ev.x, ev.y));
    } else if (ev.type === "drag") {
      await page.mouse.move(...at(ev.x, ev.y));
      await page.mouse.down();
      await page.mouse.move(...at(ev.x2, ev.y2), { steps: 25 });
      await page.mouse.up();
    } else continue;
    log(`input ${ev.type}`);
  }
}

async function main() {
  fs.mkdirSync(path.join(DIR, "profile"), { recursive: true, mode: 0o700 });
  // Keep the previous run's log beside this one.
  try { fs.renameSync(LOG_FILE, `${LOG_FILE}.prev`); } catch {}
  fs.writeFileSync(LOG_FILE, "", { mode: 0o600 });
  log("login started");
  try { fs.unlinkSync(CODE_FILE); } catch {}
  if (!EMAIL || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(EMAIL)) {
    setStatus("error", "Configure CAI_EMAIL before starting browser login.");
    process.exit(1);
  }
  setStatus("starting");
  const ctx = await chromium.launchPersistentContext(path.join(DIR, "profile"), {
    headless: false, viewport: VIEW,
    args: ["--disable-blink-features=AutomationControlled"],
  });
  page = ctx.pages()[0] || (await ctx.newPage());
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
  const codeBox = await page.locator(CODE_INPUT).first().waitFor({ timeout: 30000 }).then(() => true, () => false);
  log(codeBox ? "code box shown" : "code box not found yet");
  if (!codeBox) await recordFailure("no code box after sending the email");
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
  log(`code received (${code.length} characters)`);

  // Type it like a person: works for one field and for one-box-per-digit fields that auto-advance.
  const codeInput = page.locator(CODE_INPUT).first();
  await codeInput.waitFor({ timeout: 20000 });
  await codeInput.click();
  await codeInput.fill("").catch(() => {});
  await page.keyboard.type(code, { delay: 90 });
  await page.waitForTimeout(800);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(1500);
  const verify = page.locator('button:visible:not([disabled])').filter({ hasText: /verify|continue|sign in|log in/i }).first();
  if (page.url().includes("login") && await verify.count()) { log("clicking verify button"); await verify.click().catch(() => {}); }

  let outcome = "pending";
  let humanCheck = false;
  const deadline = Date.now() + 6 * 60_000;
  for (let i = 0; outcome === "pending" && Date.now() < deadline; i++) {
    if (humanCheck) { await applyInput(); await liveFrame(); }
    await page.waitForTimeout(humanCheck ? 400 : 1000);
    if (!page.url().includes("login")) outcome = "success";
    else if (REJECTED.test(await page.locator("body").innerText({ timeout: 2000 }).catch(() => ""))) outcome = "rejected";
    else if (!humanCheck && (i >= 8 || page.frames().some((f) => CHALLENGE.test(f.url())))) {
      // A check only a person can answer (or a page that will not move on): hand it to them.
      humanCheck = true;
      try { fs.unlinkSync(INPUT_FILE); } catch {}
      await liveFrame();
      setStatus("human_check", "claude.ai wants to check you're human — solve it in the picture below.");
    }
  }
  fs.rmSync(LIVE_FILE, { force: true });
  if (outcome === "pending" && humanCheck) {
    await recordFailure("human check not finished", path.join(DIR, "after-code.png"));
    setStatus("error", "The check wasn't finished in time — try again.");
    await ctx.close();
    process.exit(1);
  }
  if (outcome === "pending") {
    // What claude.ai shows after the code, before reloading replaces it.
    await recordFailure("no redirect after the code", path.join(DIR, "after-code.png"));
    await page.goto("https://claude.ai/", { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(5000);
    if (!page.url().includes("login")) outcome = "success";
  }
  log(`outcome: ${outcome}`);
  if (outcome === "success") setStatus("success", "Signed in.");
  else {
    await recordFailure(outcome);
    setStatus("error", outcome === "rejected"
      ? "claude.ai says the code is invalid or expired — send a new code."
      : "claude.ai didn't finish signing in — try again (details saved on the server).");
  }
  await ctx.close();
  process.exit(outcome === "success" ? 0 : 1);
}

if (require.main === module) {
  main().catch(async (e) => { await recordFailure(e.message); setStatus("error", e.message.slice(0, 200)); process.exit(1); });
}
// For tests: drive the live view against another page.
module.exports = { useLivePage: (p) => { page = p; }, liveFrame, applyInput, LIVE_FILE, INPUT_FILE };
