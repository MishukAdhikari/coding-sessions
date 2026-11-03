/**
 * The state of the last real turn in a Claude Code transcript:
 *   - "asking": Claude asked the user something interactively and is blocked on a
 *     reply (AskUserQuestion / ExitPlanMode tool_use, no reply yet).
 *   - "done":   Claude finished its turn normally (stop_reason end_turn /
 *     stop_sequence) — the conversation is idle, waiting for the next message.
 *   - "busy":   Claude is, or is about to be, working (user/tool_result last, an
 *     auto-running tool_use, or a still-streaming assistant message).
 *
 * Both "asking" and "done" mean Claude is waiting on the user, but "asking" is a
 * stronger signal — it can't make progress until you answer.
 */
export type TurnState = "asking" | "done" | "busy" | "unknown";

/**
 * Decide, from a Claude Code transcript's tail, the state of the last turn.
 * Walks back from the end to the last real turn. Pure and dependency-free so
 * it's cheap to unit-test.
 */
export function lastTurnState(tailText: string): TurnState {
  const lines = tailText.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim();
    if (!line) continue;
    let o: any;
    try { o = JSON.parse(line); } catch { continue; } // a truncated first line, etc.
    if (o.type !== "assistant" && o.type !== "user") continue;
    if (o.type === "user") return "busy";                // Claude's turn → busy
    const msg = o.message ?? {};
    const stop = msg.stop_reason;
    if (stop === "end_turn" || stop === "stop_sequence") return "done";
    if (stop === "tool_use") {
      const content = Array.isArray(msg.content) ? msg.content : [];
      const names = content.filter((x: any) => x?.type === "tool_use").map((x: any) => String(x.name ?? ""));
      return names.some((nm: string) => /AskUserQuestion|ExitPlanMode/i.test(nm)) ? "asking" : "busy";
    }
    return "busy"; // streaming / other → busy
  }
  return "unknown";
}
