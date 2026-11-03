# Security policy

Coding Sessions grants authenticated browser and MCP users the ability to run programs under its service account. It is intended for one trusted operator per dedicated Unix account and instance. It does not provide hostile multi-tenant, same-user, or cross-project isolation. See [the threat model](docs/security.md).

## Report a vulnerability privately

Use [GitHub's private vulnerability reporting page](https://github.com/MishukAdhikari/coding-sessions/security/advisories/new) for this repository. If private reporting is unavailable, do not disclose the exploit or credentials in a public issue; ask for a private reporting channel without including sensitive details.

Include the affected commit/version, operating system, configuration relevant to the problem, reproduction steps using dummy data, and expected versus observed behavior. Redact passwords, tokens, cookies, private keys, provider files, terminal transcripts, and personal repository contents. Do not test against instances you do not own or have permission to assess.

Security fixes target the current maintained code. No support window or response-time guarantee is promised. Keep your OS and provider CLIs maintained independently of application updates.
