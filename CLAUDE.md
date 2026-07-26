# 1NKY — build rules (read before touching anything)

Anonymous, registration-free platform for graffiti writers at 1nky.com.
Full spec lives OUTSIDE the repo in `.internal/` (gitignored — not for the
public repo). Architecture: Nostr data model (signed events, secp256k1 via
`nostr-tools`), self-hosted strfry relay as source of truth, Postgres indexer
as rebuildable cache, custom React PWA that hides ALL Nostr jargon,
Blossom-compatible media service on S3-compatible storage (R2 primary).

## Hard rules (violations are bugs, no exceptions)

1. **No IP addresses anywhere.** No IP columns in any schema, no IP in any log
   line, no request logging in any service. Express apps: no morgan, no
   access logs. Errors may log event ids/kinds, never connection info.
2. **No email / password / OAuth.** Identity is exclusively client-held
   Nostr keypairs. There is no "account" concept server-side.
3. **No Nostr jargon in user-facing UI copy.** Never show: nsec, npub, key,
   relay, event, kind, Nostr, crypto, sign. See copy deck below.
4. **Writes are signed events to the relay only.** The REST API is read-only.
5. **Client strips EXIF before upload** (canvas re-encode); server re-encodes
   with sharp as defense-in-depth. Server never persists original bytes.

## Copy deck (graffiti-native language, use exactly)

| Concept | User-facing copy |
|---|---|
| identity / keypair | your **tag** |
| key backup file | your **blackbook** |
| photo post (kind 20) | **flick** |
| delete a post (kind 5) | **Buff this** / "buffed" |
| retire identity | **Hang it up** (ritual, not error state) |
| invite (Phase 3) | **getting put on** |
| crew shared identity | **crew** |
| ephemeral thread | **beef** (24h/72h/7d/pinned) |
| report content | **Flag it** |
| mute (NIP-51) | **Ignore this writer** |
| pubkey fingerprint | their **mark** ("same name, different mark = different writer") |
| PoW wait | "spraying..." spinner (never mention mining) |

## Workspace conventions

- pnpm workspaces; package names `@1nky/web` `@1nky/api` `@1nky/indexer`
  `@1nky/media` `@1nky/protocol` `@1nky/docs`.
- TypeScript strict, ESM (`"type": "module"`), extend `tsconfig.base.json`
  (apps/web uses its own DOM-lib tsconfig but stays strict).
- Every workspace exposes scripts: `build`, `typecheck`, `lint`, `test`, `dev`.
  Use `vitest run` for test. Lint = `eslint .` (flat config) or a no-op
  `echo` if not yet configured — but the script must exist and exit 0.
- Node servers: Express 5, no logging middleware. Ports/config from env only.
- Shared event helpers/types live in `@1nky/protocol` — kinds, tag builders,
  PoW target checks, NIP-49 blackbook helpers, copy-deck constants.
- Env vars: see `.env.example`. Never invent new secrets without adding them
  there (with a comment).

## Pinned stack

Node 22+ (dev box runs 24), TypeScript 5.x, React 18 + Vite 6, nostr-tools ^2,
sharp ^0.33, @aws-sdk/client-s3, Postgres 16, strfry (Docker), Caddy 2.8
(logging OFF), browser-image-compression ^2.0.2, Vitest (+ Playwright later).

## Do NOT

- Modify root files (`package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`,
  `.env.example`, CI) from a subagent — root is owned by the orchestrator.
- Add public-relay publishing, NIP-29, Lightning/zaps, or video. Out of scope.
- Add analytics, telemetry, cookies, or third-party scripts to the web client.
