/**
 * Claude Code's first-run screens, read from a terminal session's screen.
 *
 * On a server where Claude Code has never run interactively (a fresh install), the
 * first session shows the theme picker and the security notes, and every new folder
 * in standard permission mode shows the folder-trust question. None of them is in a
 * transcript, so the turn state says "running" while the session is blocked. The
 * trust question's default choice is "No, exit", so an Enter pressed blindly ends
 * the session. These are reported as questions; answering trust stays the operator's.
 */

export type ClaudeStartupKind = "theme" | "security_notes" | "folder_trust";

export interface ClaudeStartupPrompt {
  kind: ClaudeStartupKind;
  question: string;
  /** What answers it, for an agent driving the session over MCP. */
  how: string;
}

const clean = (text: string) => text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/\r/g, "");

/** The first-run screen a Claude Code session is blocked on, or null. Only the screen's last lines count. */
export function claudeStartupPrompt(screen: string): ClaudeStartupPrompt | null {
  const tail = clean(screen).split("\n").map((l) => l.trim()).filter(Boolean).slice(-30).join("\n");
  if (/Is this a project you created or one you trust\?/.test(tail) && /No, exit/.test(tail) && /Yes, I trust this folder/.test(tail)) {
    return {
      kind: "folder_trust",
      question: "Claude Code asks whether to trust this folder. Its default choice is \"No, exit\", which ends the session.",
      how: "Ask the operator. If they approve, press_keys [\"down\", \"enter\"] selects \"Yes, I trust this folder\"; never a bare enter. They can also answer in the app.",
    };
  }
  if (/Choose the text style that looks best with your terminal/.test(tail)) {
    return {
      kind: "theme",
      question: "Claude Code's first-run theme picker (it has not run on this server before).",
      how: "press_keys [\"enter\"] keeps the default theme. The security notes and the folder-trust question may follow.",
    };
  }
  if (/Security notes:/.test(tail) && /Press Enter to continue/.test(tail)) {
    return {
      kind: "security_notes",
      question: "Claude Code's first-run security notes.",
      how: "press_keys [\"enter\"] continues. The folder-trust question may follow: its default is \"No, exit\".",
    };
  }
  return null;
}
