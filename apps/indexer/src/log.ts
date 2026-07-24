/**
 * The only output this process is allowed to produce.
 *
 * CLAUDE.md hard rule #1: no request logging, no connection info, ever. The
 * indexer emits counts and error messages to stderr and nothing else. There is
 * deliberately no `info(anything)` helper that takes free-form data — if you
 * want to add one, re-read the rule first.
 */

function write(line: string): void {
  process.stderr.write(`${line}\n`);
}

/** Aggregate counters. Values only, never identifiers. */
export function counts(label: string, values: Readonly<Record<string, number>>): void {
  const body = Object.entries(values)
    .filter(([, n]) => n !== 0)
    .map(([k, n]) => `${k}=${n}`)
    .join(' ');
  write(body ? `${label} ${body}` : label);
}

/** A bare lifecycle marker: `started`, `connected`, `reconnecting`. */
export function state(label: string): void {
  write(label);
}

const URL_LIKE = /\b[a-z][a-z0-9+.-]*:\/\/\S+/gi;
const IPV4_LIKE = /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(?::\d+)?\b/g;
// No leading `\b`: an IPv6 loopback (`::1`) starts with a non-word character.
const IPV6_LIKE = /(?<![\w:.])(?:[0-9a-f]{0,4}:){2,7}[0-9a-f]{0,4}(?![\w:.])/gi;

/**
 * Strips anything address-shaped out of a message.
 *
 * These are *our* addresses, not a visitor's — Node writes them into errors
 * like `connect ECONNREFUSED 127.0.0.1:7777`. They still do not belong in a
 * log line on a box whose whole promise is that it keeps none. Redacting
 * costs nothing and removes the question.
 */
export function redact(message: string): string {
  return message
    .replace(URL_LIKE, '[address]')
    .replace(IPV4_LIKE, '[address]')
    .replace(IPV6_LIKE, '[address]');
}

/** An error message. Never include connection details in `context`. */
export function error(context: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  write(`error ${context}: ${redact(message)}`);
}
