/**
 * The session board: which sessions need you, which are working, which are idle, and a sentence
 * or two on each from its newest live frames. Pure; shared by `cs live --all` and the app's Board.
 */

/** A live-feed frame, as much of it as the board reads (see server/live.ts). */
export type BoardFrame = { type: string; [key: string]: any };

export type BoardSummary = { kind: "ask" | "message" | "tool" | "none"; text: string };

export type BoardGroup = "needs" | "cooking" | "idle";


/** Which group a session belongs to: it needs you, it is working, or it is idle. Pure. */
export function boardGroup(activity: string, asking = false): BoardGroup {
  if (asking || activity === "waiting") return "needs";
  if (activity === "running" || activity === "starting") return "cooking";
  return "idle";
}

/** Agent text as one plain line: no code blocks, emphasis, headings, bullets or link targets. Pure. */
export function plainText(text: string): string {
  return text
    .replace(/```[\s\S]*?(```|$)/g, " ")
    .replace(/^\s*\|.*$/gm, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, "")
    .replace(/^\s*>\s?/gm, "")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/[*_`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** The first `n` sentences, cut at about `max` characters on a word with a real ellipsis. Pure. */
export function firstSentences(text: string, n = 2, max = 200): string {
  // A sentence ends at . ! or ? followed by a space; a dot inside a URL or a version is not an end.
  const sentences = text.split(/(?<=[.!?])\s+/);
  let out = sentences.slice(0, n).join(" ").replace(/\s+/g, " ").trim();
  if (out.length > max) {
    const cut = out.slice(0, max - 1);
    const space = cut.lastIndexOf(" ");
    out = `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:.]+$/, "")}…`;
  }
  return out;
}

/** What a session is about, from its newest live frames: its question, else its last reply, else its last tool call. Pure. */
export function boardSummary(frames: BoardFrame[], activity: string, asking = false): BoardSummary {
  const last = (type: string, role?: string) => [...frames].reverse().find((f) => f.type === type && (!role || f.role === role));
  if (boardGroup(activity, asking) === "needs") {
    const ask = last("ask");
    return { kind: "ask", text: firstSentences(plainText(String(ask?.text ?? "the agent is waiting for your answer")), 2, 200) };
  }
  const message = last("message", "assistant");
  const text = message ? plainText(String(message.text ?? "")) : "";
  if (text) return { kind: "message", text: firstSentences(text, 2, 200) };
  const tool = last("tool");
  if (tool) return { kind: "tool", text: `working: ${firstSentences(plainText(String(tool.text ?? "")), 1, 180)}` };
  return { kind: "none", text: "no messages yet" };
}
