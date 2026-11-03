export const BUILTIN_SESSION_PROVIDERS = ["claude", "codex", "command-code"] as const;
export type BuiltinSessionProvider = (typeof BUILTIN_SESSION_PROVIDERS)[number];

/** A registered Command runs under `cmd:<slug>`; built-ins keep their bare names. */
export type CommandProvider = `cmd:${string}`;
export type SessionProvider = BuiltinSessionProvider | CommandProvider;

export const COMMAND_PROVIDER_PREFIX = "cmd:";
export const COMMAND_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,30}$/;

export function isCommandProvider(provider: SessionProvider): provider is CommandProvider {
  return provider.startsWith(COMMAND_PROVIDER_PREFIX);
}

export function commandSlug(provider: SessionProvider): string | null {
  if (!isCommandProvider(provider)) return null;
  const slug = provider.slice(COMMAND_PROVIDER_PREFIX.length);
  return COMMAND_SLUG_RE.test(slug) ? slug : null;
}

export const commandProviderId = (slug: string): CommandProvider => `${COMMAND_PROVIDER_PREFIX}${slug}`;

/** @deprecated Kept for callers that only ever meant the built-ins. */
export const SESSION_PROVIDERS = BUILTIN_SESSION_PROVIDERS;

export const DEFAULT_SESSION_PROVIDER: SessionProvider = "claude";
export const LAUNCH_PROTOCOL = 2;

export interface ProviderCapabilities {
  displayName: string;
  managedLaunch: boolean;
  freshWorkspace: boolean;
  webTerminal: boolean;
  semanticStatus: boolean;
  exactResume: boolean;
  remoteControl: boolean;
  nativeChatUrl: boolean;
  chatDeletion: boolean;
  externalDiscovery: boolean;
  syncedLaunch: boolean;
  authentication: "setup-token" | "device-auth" | "api-key" | "external";
}

export const PROVIDER_CAPABILITIES: Record<BuiltinSessionProvider, Readonly<ProviderCapabilities>> = {
  claude: {
    displayName: "Claude",
    managedLaunch: true,
    freshWorkspace: true,
    webTerminal: true,
    semanticStatus: true,
    exactResume: true,
    remoteControl: true,
    nativeChatUrl: true,
    chatDeletion: true,
    externalDiscovery: true,
    syncedLaunch: true,
    authentication: "setup-token",
  },
  codex: {
    displayName: "Codex",
    managedLaunch: true,
    freshWorkspace: true,
    webTerminal: true,
    semanticStatus: true,
    exactResume: true,
    remoteControl: false,
    nativeChatUrl: false,
    chatDeletion: false,
    externalDiscovery: false,
    syncedLaunch: false,
    authentication: "device-auth",
  },
  /* Command Code keeps its conversations as addressable transcripts and reopens one
     by id, so exact resume is honest here. It publishes no lifecycle hook this app
     can subscribe to, so turn state is not — its cards report liveness, not mood. */
  "command-code": {
    displayName: "Command Code",
    managedLaunch: true,
    freshWorkspace: true,
    webTerminal: true,
    semanticStatus: false,
    exactResume: true,
    remoteControl: false,
    nativeChatUrl: false,
    chatDeletion: false,
    externalDiscovery: false,
    syncedLaunch: false,
    authentication: "api-key",
  },
};

/* Every Command gets the same profile: the lifecycle this app owns without knowing
   anything about the agent. Turn state and exact resume need per-agent hooks, so a
   Command declines them rather than guessing. */
export const COMMAND_CAPABILITIES: Readonly<ProviderCapabilities> = {
  displayName: "Command",
  managedLaunch: true,
  freshWorkspace: true,
  webTerminal: true,
  semanticStatus: false,
  exactResume: false,
  remoteControl: false,
  nativeChatUrl: false,
  chatDeletion: false,
  externalDiscovery: false,
  syncedLaunch: false,
  authentication: "external",
};

export function capabilitiesFor(provider: SessionProvider): Readonly<ProviderCapabilities> {
  return isCommandProvider(provider) ? COMMAND_CAPABILITIES : PROVIDER_CAPABILITIES[provider];
}

export const APP_CAPABILITIES = {
  launchProtocol: LAUNCH_PROTOCOL,
  supportedProviders: SESSION_PROVIDERS,
  providers: PROVIDER_CAPABILITIES,
} as const;

/**
 * Shape-only validation. A `cmd:*` id parses as itself so a stored row is never
 * silently re-read as Claude; whether the slug is still registered is a separate
 * question, answered where the database is in scope.
 */
export function parseSessionProvider(value: unknown): SessionProvider | null {
  if (value === "claude" || value === "codex" || value === "command-code") return value;
  if (typeof value !== "string" || !value.startsWith(COMMAND_PROVIDER_PREFIX)) return null;
  return COMMAND_SLUG_RE.test(value.slice(COMMAND_PROVIDER_PREFIX.length)) ? value as CommandProvider : null;
}

export type LaunchOptionsResult =
  | { ok: true; provider: SessionProvider; remoteControl: boolean }
  | { ok: false; error: string };

/** Validate provider-specific launch options while preserving legacy Claude defaults. */
export function launchOptionsFromRequest(body: unknown): LaunchOptionsResult {
  const request = body && typeof body === "object" ? body as Record<string, unknown> : {};
  const hasProvider = Object.prototype.hasOwnProperty.call(request, "provider");
  const provider = hasProvider ? parseSessionProvider(request.provider) : DEFAULT_SESSION_PROVIDER;
  if (!provider) {
    return { ok: false, error: "Provider must be “claude”, “codex”, “command-code”, or a registered command." };
  }

  if (!capabilitiesFor(provider).remoteControl) {
    const hasRemoteControl = Object.prototype.hasOwnProperty.call(request, "remoteControl");
    if (hasRemoteControl && request.remoteControl !== false) {
      return { ok: false, error: "Remote Control is only available for Claude sessions." };
    }
    return { ok: true, provider, remoteControl: false };
  }

  return { ok: true, provider, remoteControl: request.remoteControl !== false };
}
