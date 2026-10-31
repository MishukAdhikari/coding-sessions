/**
 * Output/input filtering for the web terminal relay.
 *
 * 1. Mouse sequences — screen sessions only. Claude's TUI enables SGR mouse
 *    tracking, but its input handler doesn't reliably consume the mouse REPORTS
 *    through the `screen` layer, so they leak into the prompt as junk like
 *    `<0;22;1M` (anthropics/claude-code#30644, #38810). For those bridges:
 *      - downstream (server→browser): strip mouse/focus-mode ENABLE sequences so
 *        xterm.js never turns mouse reporting on → it never emits reports.
 *      - upstream (browser→server): drop any reports that still slip through.
 *    zmx bridges pass the mouse through (`{ mouse: true }`): nothing emulates
 *    the terminal in between, and the mouse is how Claude's fullscreen renderer
 *    scrolls, selects and expands. `XCS_TERM_MOUSE=off` strips it everywhere.
 *
 * 2. Bold accent — Claude renders `/commands` (and other emphasis) as plain bold
 *    (`ESC[1m`), which a terminal can't turn into a colour on its own. We rewrite
 *    a standalone bold-on into bold + an accent colour, and make bold-off also
 *    reset the foreground so the tint never bleeds into following text. Text that
 *    Claude already colours (e.g. `ESC[1;31m`, or `ESC[1m` followed by its own
 *    colour) is left as-is.
 *
 * ttyd frames both directions as `'0' (0x30) + payload`; other command bytes
 * (set-title '1', set-prefs '2', …) pass through untouched, and we only rewrite
 * a frame when the payload actually changes, so the hot path stays cheap.
 */

// --- mouse ---
// Only a private-mode SET whose modes are ALL mouse/focus (1000–1006, 1015, 1016);
// deliberately won't match a set that also carries a non-mouse mode (e.g. alt-screen).
const MOUSE_ENABLE_RE = /\x1b\[\?(?:100[0-6]|1015|1016)(?:;(?:100[0-6]|1015|1016))*h/g;
// SGR mouse reports (`ESC[<b;x;yM|m`) and legacy X10 (`ESC[M` + 3 bytes).
const MOUSE_REPORT_RE = /\x1b\[<\d+;\d+;\d+[Mm]|\x1b\[M[\s\S]{3}/g;

// --- bold accent ---
// Bold + amber (xterm 256-colour 214). Set to "" to disable the recolour.
const BOLD_ACCENT = "\x1b[1;38;5;214m";
const BOLD_ON_RE = /\x1b\[0?1m/g;   // ESC[1m / ESC[01m — standalone bold, no colour
const BOLD_OFF_RE = /\x1b\[22m/g;   // bold off → also reset fg so the tint doesn't bleed

const OUTPUT_CMD = 0x30; // ttyd '0' command prefix (both input and output frames)

function recolourBold(body: string): string {
  return BOLD_ACCENT ? body.replace(BOLD_ON_RE, BOLD_ACCENT).replace(BOLD_OFF_RE, "\x1b[22;39m") : body;
}
function downstreamTransform(body: string): string {
  return recolourBold(body.replace(MOUSE_ENABLE_RE, ""));
}
function upstreamTransform(body: string): string {
  return body.replace(MOUSE_REPORT_RE, "");
}

export interface FilterOptions {
  /** Let mouse tracking and reports through (bridges whose holder doesn't emulate the terminal). */
  mouse?: boolean;
}

const mouseAllowed = (opts?: FilterOptions): boolean => !!opts?.mouse && process.env.XCS_TERM_MOUSE !== "off";

export type Frame = string | ArrayBuffer | Uint8Array;

/** Apply `transform` to a ttyd frame's payload (after the '0' command byte).
 *  Returns the same object type given, unchanged if the payload didn't change. */
function transformFrame(data: Frame, transform: (body: string) => string): Frame {
  if (typeof data === "string") {
    if (data.charCodeAt(0) !== OUTPUT_CMD) return data;
    const body = data.slice(1);
    const s = transform(body);
    return s === body ? data : "0" + s;
  }
  const u = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (u.length === 0 || u[0] !== OUTPUT_CMD) return data;
  // Escape/mouse/SGR bytes are ASCII; latin1 (byte↔char) round-trips arbitrary bytes.
  let body = "";
  for (let i = 1; i < u.length; i++) body += String.fromCharCode(u[i]);
  const s = transform(body);
  if (s === body) return data;
  const out = new Uint8Array(1 + s.length);
  out[0] = OUTPUT_CMD;
  for (let i = 0; i < s.length; i++) out[i + 1] = s.charCodeAt(i) & 0xff;
  return out;
}

/** server → browser: neutralize mouse enables (unless allowed), recolour standalone bold. */
export const filterDownstream = (data: Frame, opts?: FilterOptions): Frame =>
  transformFrame(data, mouseAllowed(opts) ? recolourBold : downstreamTransform);
/** browser → server: drop stray mouse reports (unless allowed). */
export const filterUpstream = (data: Frame, opts?: FilterOptions): Frame =>
  mouseAllowed(opts) ? data : transformFrame(data, upstreamTransform);
