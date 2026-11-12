/** Claude Code first-run screens, for tests. */
// As read_session showed them on a fresh Ubuntu 24.04 server (Claude Code 2.1.322).
export const THEME = `Welcome to Claude Code v2.1.322

 Let's get started.

 Choose the text style that looks best with your terminal
 To change this later, run /theme

     Auto (match terminal)
 ❯ ✔ Dark mode
     Light mode`;

export const SECURITY = `Welcome to Claude Code v2.1.322

 Security notes:

 1. Claude can make mistakes.
 2. Due to prompt injection risks, only use it with code you trust

 Press Enter to continue…`;

export const TRUST = ` Accessing workspace:

 /var/lib/coding-sessions/personal/workspaces/e2e-full2

 Quick safety check: Is this a project you created or one you trust? (Like your
 own code, a well-known open source project, or work from your team).

 Claude Code'll be able to read, edit, and execute files here.

 ❯ No, exit
   Yes, I trust this folder

 Enter to confirm · Esc to cancel`;
