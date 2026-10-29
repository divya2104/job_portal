import robotsParser from "robots-parser";

export const USER_AGENT = "JobPortalBot/0.1 (personal job search; respects robots.txt)";

export class HttpError extends Error {
  status: number;
  constructor(status: number, url: string) {
    super(`HTTP ${status} for ${url}`);
    this.status = status;
  }
}

export const settings = { throttleMs: 2000, backoffMs: [1000, 4000, 16000] };

// ponytail: in-process per-domain throttle; one worker process. Use a Postgres advisory lock if the worker is ever sharded.
const lastHit = new Map<string, number>();
async function throttle(url: string) {
  const host = new URL(url).hostname;
  const wait = (lastHit.get(host) ?? 0) + settings.throttleMs - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastHit.set(host, Date.now());
}

/** Throttled fetch with 3 retries (exponential backoff, honours Retry-After) on network errors, 429 and 5xx. */
export async function http(url: string, init: RequestInit = {}): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    await throttle(url);
    let res: Response | undefined;
    try {
      res = await fetch(url, { ...init, headers: { "user-agent": USER_AGENT, ...init.headers }, signal: AbortSignal.timeout(30000) });
      if (res.status !== 429 && res.status < 500) return res;
    } catch (e) {
      // undici hides the real reason (DNS, TLS, reset, timeout) in `cause`; surface it in run_sources.error.
      const cause = (e as any).cause;
      if (attempt >= settings.backoffMs.length) throw new Error(`${(e as Error).message} (${cause?.code ?? cause?.message ?? "no cause"}) for ${url}`);
    }
    if (attempt >= settings.backoffMs.length) return res!;
    const retryAfter = Number(res?.headers.get("retry-after"));
    await new Promise((r) => setTimeout(r, retryAfter > 0 ? Math.min(retryAfter, 60) * 1000 : settings.backoffMs[attempt]));
  }
}

export async function httpJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await http(url, init);
  if (!res.ok) throw new HttpError(res.status, url);
  return res.json() as Promise<T>;
}

const robotsCache = new Map<string, { at: number; robots: ReturnType<typeof robotsParser> | null }>();
/** robots.txt check for non-API hosts (cached 24 h). Missing/unreadable robots.txt → allowed. */
export async function robotsAllowed(url: string): Promise<boolean> {
  const origin = new URL(url).origin;
  let entry = robotsCache.get(origin);
  if (!entry || Date.now() - entry.at > 86_400_000) {
    let robots = null;
    try {
      const res = await http(`${origin}/robots.txt`);
      if (res.ok) robots = robotsParser(`${origin}/robots.txt`, await res.text());
    } catch {}
    entry = { at: Date.now(), robots };
    robotsCache.set(origin, entry);
  }
  return entry.robots?.isAllowed(url, USER_AGENT) ?? true;
}
