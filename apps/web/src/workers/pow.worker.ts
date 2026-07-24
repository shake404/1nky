import { mineTemplate, type PowRequest, type PowResponse } from './pow.core.js';

/**
 * Proof-of-work miner. Runs off the main thread so the UI keeps painting the
 * "spraying..." spinner while the phone grinds.
 *
 * Plain `postMessage` — no comlink, no extra bytes on the wire.
 */

const ctx = self as unknown as {
  postMessage: (message: PowResponse) => void;
  onmessage: ((event: MessageEvent<PowRequest>) => void) | null;
};

ctx.onmessage = (event: MessageEvent<PowRequest>) => {
  const request = event.data;
  try {
    ctx.postMessage({ job: request.job, ok: true, event: mineTemplate(request) });
  } catch (error) {
    ctx.postMessage({
      job: request.job,
      ok: false,
      error: error instanceof Error ? error.message : 'could not finish',
    });
  }
};
