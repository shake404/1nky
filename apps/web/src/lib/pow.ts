import { finalizeEvent, type EventTemplate, type SignedEvent } from '@1nky/protocol';
import { mineTemplate, type PowRequest, type PowResponse } from '../workers/pow.core.js';

/**
 * Main-thread side of the miner.
 *
 * One worker, reused across posts — spinning up a fresh one per event costs
 * more than the work does at low difficulty.
 */

let worker: Worker | null = null;
let jobCounter = 0;

function ensureWorker(): Worker | null {
  if (worker) return worker;
  if (typeof Worker === 'undefined') return null;
  try {
    worker = new Worker(new URL('../workers/pow.worker.ts', import.meta.url), { type: 'module' });
  } catch {
    worker = null;
  }
  return worker;
}

/** Mine a nonce onto `template`. Falls back to the main thread if workers are unavailable. */
export function mine(template: EventTemplate, pubkey: string, bits: number): Promise<SignedEventDraft> {
  const request: PowRequest = {
    job: `j${(jobCounter += 1).toString(36)}`,
    template,
    pubkey,
    bits,
  };

  const host = ensureWorker();
  if (!host) return Promise.resolve(mineTemplate(request));

  return new Promise<SignedEventDraft>((resolve, reject) => {
    const onMessage = (event: MessageEvent<PowResponse>): void => {
      if (event.data.job !== request.job) return;
      cleanup();
      if (event.data.ok) resolve(event.data.event);
      else reject(new Error(event.data.error));
    };
    const onError = (): void => {
      cleanup();
      // A dead worker is not a dead post — grind it here instead.
      worker = null;
      try {
        resolve(mineTemplate(request));
      } catch (error) {
        reject(error instanceof Error ? error : new Error('could not finish'));
      }
    };
    const cleanup = (): void => {
      host.removeEventListener('message', onMessage as EventListener);
      host.removeEventListener('error', onError);
    };
    host.addEventListener('message', onMessage as EventListener);
    host.addEventListener('error', onError);
    host.postMessage(request);
  });
}

type SignedEventDraft = ReturnType<typeof mineTemplate>;

/**
 * Mine, then sign.
 *
 * `finalizeEvent` re-derives the id from the template it is handed, so the
 * mined `tags` and `created_at` must be passed through untouched — change
 * either and the work evaporates.
 */
export async function mineAndSign(
  template: EventTemplate,
  secret: Uint8Array,
  pubkey: string,
  bits: number,
): Promise<SignedEvent> {
  const mined = await mine(template, pubkey, bits);
  return finalizeEvent(
    {
      kind: mined.kind,
      tags: mined.tags,
      content: mined.content,
      created_at: mined.created_at,
    },
    secret,
  );
}

/** Drop the worker — used when the app goes to sleep or the tag is wiped. */
export function stopMiner(): void {
  worker?.terminate();
  worker = null;
}
