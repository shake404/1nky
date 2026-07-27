#!/usr/bin/env node
// =============================================================================
// verify-1nky.mjs — check that a 1NKY origin serves exactly the code a release
// published. Zero dependencies: Node 18+ (node:crypto + global fetch) only.
//
//   node verify-1nky.mjs <manifest>            # manifest = file path OR URL
//   node verify-1nky.mjs <manifest> <origin>   # origin defaults to https://1nky.com
//
// The manifest is the dist-manifest.json attached to a GitHub release
// (github.com/shake404/1nky/releases), schema:
//   { "commit": "<sha>", "generated": "<iso8601>",
//     "files": { "<relative-path>": "<sha256hex>", ... } }
// For every file it lists, this script fetches <origin>/<path>, hashes the bytes
// your machine actually receives, and compares. It also reads <origin>/index.html
// and checks that every /assets/* file the app shell pulls in is one the manifest
// vouches for — so nothing un-attested gets loaded.
//
// Exit code is 0 only if every file matches and the shell references nothing
// outside the manifest; non-zero otherwise. Nothing is sent anywhere but the
// origin and the manifest URL — no telemetry, no third party.
//
// Over Tor (the .onion origin): the check itself should ride the onion too, so
// you're not proving one thing from a path that betrays another. Two ways, none
// of which need any SOCKS code in this script:
//
//   * torsocks wraps the whole process and routes every TCP connection through
//     SOCKS:
//       torsocks node verify-1nky.mjs <manifest> http://<address>.onion
//
//   * An HTTP proxy env var. Set HTTPS_PROXY (or HTTP_PROXY) to a Tor HTTP proxy
//     port and launch Node with `--use-env-proxy` (Node 24+), which makes global
//     fetch honor it:
//       HTTPS_PROXY=http://127.0.0.1:8118 node --use-env-proxy \
//         verify-1nky.mjs <manifest> http://<address>.onion
//     On Node 18–23 there's no built-in flag, so use torsocks or an external
//     wrapper (proxychains-ng, etc.) for the env-var path instead.
// =============================================================================

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const [, , manifestArg, originArg] = process.argv;
const ORIGIN = (originArg ?? 'https://1nky.com').replace(/\/+$/, '');

if (!manifestArg) {
  console.error('usage: node verify-1nky.mjs <manifest-file-or-URL> [origin]');
  process.exit(2);
}

const isUrl = (s) => /^https?:\/\//i.test(s);

async function loadManifest(src) {
  if (isUrl(src)) {
    const res = await fetch(src);
    if (!res.ok) throw new Error(`manifest fetch failed: HTTP ${res.status}`);
    return res.json();
  }
  return JSON.parse(await readFile(src, 'utf8'));
}

async function sha256(url) {
  const res = await fetch(url, { redirect: 'manual' });
  if (res.status !== 200) return { status: res.status, hash: null };
  const buf = Buffer.from(await res.arrayBuffer());
  return { status: 200, hash: createHash('sha256').update(buf).digest('hex') };
}

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const DIM = '\x1b[90m';
const OFF = '\x1b[0m';

const main = async () => {
  const manifest = await loadManifest(manifestArg);
  const files = manifest.files ?? {};
  const paths = Object.keys(files);
  if (paths.length === 0) throw new Error('manifest lists no files');

  console.log(`${DIM}manifest${OFF}  ${manifest.tag ?? '?'} @ ${(manifest.commit ?? '?').slice(0, 12)}`);
  console.log(`${DIM}origin${OFF}    ${ORIGIN}`);
  console.log(`${DIM}files${OFF}     ${paths.length}\n`);

  let ok = 0;
  let bad = 0;

  for (const path of paths.sort()) {
    const want = files[path];
    let got;
    try {
      got = await sha256(`${ORIGIN}/${path}`);
    } catch (err) {
      console.log(`${RED}ERROR   ${OFF}${path}  (${err.message})`);
      bad += 1;
      continue;
    }
    if (got.status !== 200) {
      console.log(`${RED}MISSING ${OFF}${path}  (HTTP ${got.status})`);
      bad += 1;
      continue;
    }
    if (got.hash === want) {
      console.log(`${GREEN}ok      ${OFF}${path}`);
      ok += 1;
    } else {
      console.log(`${RED}MISMATCH${OFF} ${path}`);
      console.log(`         ${DIM}want${OFF} ${want}`);
      console.log(`         ${DIM}got ${OFF} ${got.hash}`);
      bad += 1;
    }
  }

  // The app shell must not pull in any asset the manifest doesn't vouch for.
  let shellBad = 0;
  try {
    const res = await fetch(`${ORIGIN}/index.html`, { redirect: 'manual' });
    if (res.status === 200) {
      const html = await res.text();
      const refs = new Set([...html.matchAll(/(?:src|href)=["'](\/assets\/[^"']+)["']/g)].map((m) => m[1].slice(1)));
      for (const ref of refs) {
        if (!(ref in files)) {
          console.log(`${RED}UNLISTED${OFF} index.html references ${ref} — not in the manifest`);
          shellBad += 1;
        }
      }
    } else {
      console.log(`${RED}index.html: HTTP ${res.status}${OFF}`);
      shellBad += 1;
    }
  } catch (err) {
    console.log(`${RED}index.html fetch failed: ${err.message}${OFF}`);
    shellBad += 1;
  }

  console.log('');
  if (bad === 0 && shellBad === 0) {
    console.log(`${GREEN}VERIFIED${OFF}  ${ok}/${paths.length} files match, and the app shell loads nothing unlisted.`);
    console.log(`${DIM}${ORIGIN} is serving exactly the code ${manifest.tag ?? 'this release'} published.${OFF}`);
    process.exitCode = 0;
    return;
  }
  console.log(`${RED}FAILED${OFF}  ${ok} ok, ${bad} file problem(s), ${shellBad} shell problem(s).`);
  console.log(`Do not trust this origin until this is explained. See https://docs.1nky.com/security`);
  process.exitCode = 1;
};

main().catch((err) => {
  console.error(`${RED}verify error:${OFF} ${err.message}`);
  process.exitCode = 2;
});
