/**
 * GitHub's state for the PR links on session cards (server/pr-links.ts): open, draft, merged
 * or closed, and the PR's title.
 *
 * A card is polled every few seconds, so a lookup never waits on GitHub: get() answers from
 * the cache at once and refreshes in the background. Until GitHub has answered, and whenever
 * it can't (gh signed out, the repo out of reach), the state is "unknown", which the card
 * shows as a neutral dot: a chip never claims a state GitHub did not confirm.
 */
import { fetchPull, parsePullRef, type PullDetail } from "./repo-refs";

export type PrState = "open" | "draft" | "merged" | "closed" | "unknown";
export interface PrStatus { state: PrState; title: string | null }

type Fetch = (url: string) => Promise<{ ok: true; data: PullDetail } | { ok: false; error: string }>;

const UNKNOWN: PrStatus = { state: "unknown", title: null };

/** GitHub's PR state words, and a draft flag, as the card's states. Pure. */
export function prStateOf(pr: Pick<PullDetail, "state" | "draft">): PrState {
  switch (pr.state.toUpperCase()) {
    case "OPEN": return pr.draft ? "draft" : "open";
    case "MERGED": return "merged";
    case "CLOSED": return "closed";
    default: return "unknown";
  }
}

const defaultFetch: Fetch = async (url) => {
  const ref = parsePullRef(url);
  return ref ? fetchPull(ref) : { ok: false, error: "not a pull request link" };
};

export function createPrStatusCache(options: { fetch?: Fetch; now?: () => number; ttlMs?: number; failureTtlMs?: number } = {}) {
  const fetchOne = options.fetch ?? defaultFetch;
  const now = options.now ?? Date.now;
  const ttl = options.ttlMs ?? 300_000;
  // A failure is retried sooner, but not on every poll of a server whose gh is signed out.
  const failureTtl = options.failureTtlMs ?? 60_000;
  const cache = new Map<string, { status: PrStatus; until: number }>();
  const inFlight = new Map<string, Promise<void>>();

  function refresh(url: string): Promise<void> {
    const running = inFlight.get(url);
    if (running) return running;
    const job = (async () => {
      let status: PrStatus = UNKNOWN;
      let until = now() + failureTtl;
      try {
        const result = await fetchOne(url);
        if (result.ok) {
          status = { state: prStateOf(result.data), title: result.data.title || null };
          if (status.state !== "unknown") until = now() + ttl;
        }
      } catch { /* unknown, retried after failureTtl */ }
      // Keep a state GitHub confirmed earlier rather than dropping to unknown on one failed refresh.
      const previous = cache.get(url)?.status;
      cache.set(url, { status: status.state === "unknown" && previous && previous.state !== "unknown" ? previous : status, until });
    })().finally(() => inFlight.delete(url));
    inFlight.set(url, job);
    return job;
  }

  /** The cached state of `url` now; starts a background refresh when it is missing or old. */
  function get(url: string): PrStatus {
    const entry = cache.get(url);
    if (!entry || entry.until <= now()) void refresh(url);
    return entry?.status ?? UNKNOWN;
  }

  /** Wait for any refreshes in flight (tests). */
  async function settled(): Promise<void> {
    await Promise.all([...inFlight.values()]);
  }

  return { get, settled };
}
