/*
 * 1NKY load test (HANDOFF item P).
 *
 * Scenarios:
 *   ws_subs   — ramp to 500 concurrent relay subscriptions (REQ, wait for
 *               EOSE, hold the socket, then close). This is the launch-day
 *               shape: many readers, few writers.
 *   api_reads — steady REST reads (feed, boards, explore facets) at 5 rps.
 *   uploads   — OPTIONAL, only when UPLOADS_FILE is set: replays pre-signed
 *               Blossom upload auths at ~50/min. Generate the file with
 *               gen-uploads.mjs (same directory) and clean up afterwards
 *               with the DELETE auths it also emits.
 *
 * Run (from the repo root; results land in infra/loadtest/results/):
 *   docker run --rm -i -v ${PWD}/infra/loadtest:/lt grafana/k6 run \
 *     -e RELAY_WS=wss://api.1nky.com/relay -e API=https://api.1nky.com/api \
 *     --summary-export /lt/results/summary.json /lt/relay-load.js
 *
 * No identities are exercised beyond throwaway test keys; nothing here logs
 * or stores anything about real writers.
 */
import http from 'k6/http';
import ws from 'k6/ws';
import { check, sleep } from 'k6';
import { Counter, Trend } from 'k6/metrics';

const RELAY_WS = __ENV.RELAY_WS || 'wss://api.1nky.com/relay';
const API = __ENV.API || 'https://api.1nky.com/api';
const MEDIA = __ENV.MEDIA || 'https://api.1nky.com/media';
const UPLOADS_FILE = __ENV.UPLOADS_FILE || '';

const eoseTime = new Trend('relay_eose_ms', true);
const wsFail = new Counter('relay_ws_failures');

const uploads = UPLOADS_FILE ? JSON.parse(open(UPLOADS_FILE)) : [];

export const options = {
  scenarios: {
    ws_subs: {
      executor: 'ramping-vus',
      exec: 'relaySub',
      startVUs: 0,
      stages: [
        { duration: '1m', target: 500 },
        { duration: '3m', target: 500 },
        { duration: '30s', target: 0 },
      ],
      gracefulStop: '30s',
    },
    api_reads: {
      executor: 'constant-arrival-rate',
      exec: 'apiRead',
      rate: 5,
      timeUnit: '1s',
      duration: '4m30s',
      preAllocatedVUs: 10,
      maxVUs: 30,
    },
    ...(uploads.length
      ? {
          uploads: {
            executor: 'constant-arrival-rate',
            exec: 'upload',
            rate: 50,
            timeUnit: '1m',
            duration: '4m',
            preAllocatedVUs: 5,
            maxVUs: 15,
          },
        }
      : {}),
  },
  thresholds: {
    relay_eose_ms: ['p(95)<2000'],
    relay_ws_failures: ['count<25'], // <1% of ~2500 socket lifetimes
    http_req_failed: ['rate<0.02'],
    http_req_duration: ['p(95)<1500'],
  },
};

export function relaySub() {
  const subId = `lt-${__VU}-${__ITER}`;
  const started = Date.now();
  const res = ws.connect(RELAY_WS, {}, (socket) => {
    socket.on('open', () => {
      socket.send(JSON.stringify(['REQ', subId, { kinds: [20, 1], limit: 10 }]));
    });
    socket.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }
      if (msg[0] === 'EOSE' && msg[1] === subId) {
        eoseTime.add(Date.now() - started);
        // Hold the subscription open like a real reader on the wall.
        socket.setTimeout(() => {
          socket.send(JSON.stringify(['CLOSE', subId]));
          socket.close();
        }, 20000 + Math.floor(Math.random() * 20000));
      }
    });
    socket.on('error', () => wsFail.add(1));
    // Belt and braces: never hold a VU hostage.
    socket.setTimeout(() => socket.close(), 55000);
  });
  check(res, { 'ws 101': (r) => r && r.status === 101 }) || wsFail.add(1);
  sleep(1);
}

export function apiRead() {
  const pick = Math.random();
  const url =
    pick < 0.5 ? `${API}/feed?limit=24` : pick < 0.8 ? `${API}/boards` : `${API}/explore/facets`;
  const res = http.get(url, { headers: { Accept: 'application/json' } });
  check(res, { 'read 200': (r) => r.status === 200 });
}

export function upload() {
  if (!uploads.length) return;
  const job = uploads[(__VU * 131 + __ITER) % uploads.length];
  const body = new Uint8Array(job.bodyBase64.length);
  // k6 has no atob in init-free contexts; decode manually.
  const bin = decodeBase64(job.bodyBase64);
  const res = http.put(`${MEDIA}/upload`, bin, {
    headers: {
      Authorization: `Nostr ${job.authBase64}`,
      'Content-Type': job.mime,
    },
  });
  check(res, { 'upload 2xx': (r) => r.status === 200 || r.status === 201 });
}

function decodeBase64(b64) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const clean = b64.replace(/=+$/, '');
  const out = [];
  let buffer = 0;
  let bits = 0;
  for (const ch of clean) {
    buffer = (buffer << 6) | chars.indexOf(ch);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >> bits) & 0xff);
    }
  }
  return new Uint8Array(out).buffer;
}
