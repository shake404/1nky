/**
 * Best-effort blob mirroring to a public Blossom server (BUD-04).
 *
 * Our bucket stays primary. This is offsite, content-addressed redundancy: on
 * every successful upload the stored blob's public URL is queued, and a worker
 * asks the mirror to fetch it (`PUT <mirror>/mirror` with `{"url": …}`).
 *
 * Non-goals, deliberately:
 *  - It never blocks, slows, or fails a user's upload. `enqueue` is synchronous,
 *    returns immediately, and every error inside the worker is swallowed.
 *  - There is no queue persistence. A restart loses whatever was pending; the
 *    blob is still safe in the primary bucket, so the only loss is redundancy.
 *  - Nothing about the request is logged. Lines are counters plus an HTTP status
 *    — no URLs (a URL carries the content hash), no marks, no bodies.
 */

export interface MirrorJob {
  /** Address of the STORED bytes (post re-encode / transcode). */
  readonly sha256: string;
  /** Public URL the mirror will fetch the bytes from. */
  readonly url: string;
  readonly size: number;
  readonly mime: string;
  /**
   * Optional `Authorization: Nostr …` header to forward.
   *
   * The upload's own auth event is NOT reused: its `x` tag names the bytes the
   * client sent, and we mirror the bytes we produced after the mandatory
   * re-encode, so a BUD-04 server checking `x` against what it downloads would
   * reject it. Unauthenticated mirroring is the norm on public servers; a 401
   * is treated as "this server does not want our blobs" and dropped. The field
   * exists so a future service-owned signer can supply a correct event.
   */
  readonly authorization?: string;
}

export interface MirrorStats {
  readonly enqueued: number;
  /** Blobs the mirror accepted. */
  readonly mirrored: number;
  /** Blobs given up on after exhausting retries. */
  readonly failed: number;
  /** Blobs the mirror refused to take (401/403) — no retry. */
  readonly rejected: number;
  /** Blobs never attempted because the queue was full. */
  readonly dropped: number;
}

export interface MirrorQueue {
  /** Fire-and-forget. Never throws, never awaits. */
  enqueue(job: MirrorJob): void;
  stats(): MirrorStats;
  /** Resolves once the queue is empty and nothing is in flight (tests/shutdown). */
  idle(): Promise<void>;
}

export interface MirrorOptions {
  /** Origin of the mirror, e.g. `https://blossom.band`. */
  readonly mirrorUrl: string;
  /** Simultaneous mirror requests. @default 1 */
  readonly concurrency?: number;
  /** Total tries per blob, including the first. @default 3 */
  readonly attempts?: number;
  /** Hard bound on pending jobs so a dead mirror cannot eat the heap. @default 500 */
  readonly maxQueue?: number;
  /** Injectable for tests. */
  readonly fetchImpl?: typeof fetch;
  /** Injectable for tests, so retry backoff costs nothing. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Injectable sink; defaults to a counters-only line on stdout. */
  readonly log?: (line: string) => void;
  /** Per-request timeout in ms. @default 15000 */
  readonly requestTimeoutMs?: number;
}

const DEFAULT_ATTEMPTS = 3;
const DEFAULT_MAX_QUEUE = 500;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const BACKOFF_BASE_MS = 500;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    // Never hold the process open for a best-effort backoff.
    timer.unref();
  });
}

function defaultLog(line: string): void {
  process.stdout.write(`${line}\n`);
}

/** 500ms, 1s, 2s … — short enough to finish, long enough to matter. */
function backoffMs(attempt: number): number {
  return BACKOFF_BASE_MS * 2 ** (attempt - 1);
}

/**
 * In-process BUD-04 mirror queue.
 *
 * Nothing here is durable and nothing here is critical: the worst case is that
 * a blob exists only in the primary bucket, which is where it lived anyway.
 */
export class BlossomMirrorQueue implements MirrorQueue {
  readonly #endpoint: string;
  readonly #concurrency: number;
  readonly #attempts: number;
  readonly #maxQueue: number;
  readonly #fetch: typeof fetch;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #log: (line: string) => void;
  readonly #requestTimeoutMs: number;

  readonly #queue: MirrorJob[] = [];
  #active = 0;
  #idleWaiters: Array<() => void> = [];

  #enqueued = 0;
  #mirrored = 0;
  #failed = 0;
  #rejected = 0;
  #dropped = 0;

  constructor(options: MirrorOptions) {
    this.#endpoint = `${options.mirrorUrl.replace(/\/+$/, '')}/mirror`;
    this.#concurrency = Math.max(1, options.concurrency ?? 1);
    this.#attempts = Math.max(1, options.attempts ?? DEFAULT_ATTEMPTS);
    this.#maxQueue = Math.max(1, options.maxQueue ?? DEFAULT_MAX_QUEUE);
    this.#fetch = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.#sleep = options.sleep ?? defaultSleep;
    this.#log = options.log ?? defaultLog;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  enqueue(job: MirrorJob): void {
    if (this.#queue.length >= this.#maxQueue) {
      this.#dropped += 1;
      this.#log(`media-mirror: dropped queue full (dropped=${this.#dropped})`);
      return;
    }
    this.#queue.push(job);
    this.#enqueued += 1;
    this.#pump();
  }

  stats(): MirrorStats {
    return {
      enqueued: this.#enqueued,
      mirrored: this.#mirrored,
      failed: this.#failed,
      rejected: this.#rejected,
      dropped: this.#dropped,
    };
  }

  idle(): Promise<void> {
    if (this.#queue.length === 0 && this.#active === 0) return Promise.resolve();
    return new Promise((resolve) => {
      this.#idleWaiters.push(resolve);
    });
  }

  #pump(): void {
    while (this.#active < this.#concurrency && this.#queue.length > 0) {
      const job = this.#queue.shift()!;
      this.#active += 1;
      // Detached on purpose: the upload response has already been sent.
      void this.#run(job)
        .catch(() => {
          // #run swallows its own errors; this is belt and braces.
        })
        .finally(() => {
          this.#active -= 1;
          if (this.#queue.length > 0) {
            this.#pump();
            return;
          }
          if (this.#active === 0) this.#settleIdle();
        });
    }
  }

  #settleIdle(): void {
    const waiters = this.#idleWaiters;
    this.#idleWaiters = [];
    for (const resolve of waiters) resolve();
  }

  async #run(job: MirrorJob): Promise<void> {
    for (let attempt = 1; attempt <= this.#attempts; attempt += 1) {
      const status = await this.#attempt(job);

      if (status === 'ok') {
        this.#mirrored += 1;
        this.#log(`media-mirror: ok (mirrored=${this.#mirrored})`);
        return;
      }

      // The mirror wants credentials we cannot produce. Retrying will not help.
      if (status === 401 || status === 403) {
        this.#rejected += 1;
        this.#log(`media-mirror: rejected status=${status} (rejected=${this.#rejected})`);
        return;
      }

      if (attempt === this.#attempts) {
        this.#failed += 1;
        this.#log(
          `media-mirror: failed status=${status === 'error' ? 'none' : status} (failed=${this.#failed})`,
        );
        return;
      }

      await this.#sleep(backoffMs(attempt));
    }
  }

  /** One BUD-04 request. Returns 'ok', an HTTP status, or 'error' for a throw. */
  async #attempt(job: MirrorJob): Promise<'ok' | 'error' | number> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (job.authorization !== undefined && job.authorization !== '') {
      headers['Authorization'] = job.authorization;
    }

    try {
      const res = await this.#fetch(this.#endpoint, {
        method: 'PUT',
        headers,
        body: JSON.stringify({ url: job.url }),
        signal: AbortSignal.timeout(this.#requestTimeoutMs),
      });
      return res.ok ? 'ok' : res.status;
    } catch {
      // Network failure / timeout. No detail is logged: the only interesting
      // facts (host, URL) are exactly the ones we refuse to write down.
      return 'error';
    }
  }
}

/**
 * Builds a mirror queue when one is configured, otherwise undefined so the app
 * skips mirroring altogether.
 */
export function createMirrorQueue(
  config: { readonly mirrorUrl: string | undefined; readonly mirrorConcurrency: number },
  overrides: Omit<MirrorOptions, 'mirrorUrl' | 'concurrency'> = {},
): MirrorQueue | undefined {
  if (config.mirrorUrl === undefined || config.mirrorUrl === '') return undefined;
  return new BlossomMirrorQueue({
    mirrorUrl: config.mirrorUrl,
    concurrency: config.mirrorConcurrency,
    ...overrides,
  });
}
