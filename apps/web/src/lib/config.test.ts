import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Where the client thinks the three services live.
 *
 * Two worlds: the ordinary one, where the build stamped absolute addresses in,
 * and a hidden service, where sending a visitor to another host would undo the
 * only thing the address was for. The second is derived from the address bar at
 * module init, so these tests stand the address bar up first and then import.
 */

const REAL_LOCATION = globalThis.location;

/** Point `globalThis.location` at a made-up address for one test. */
function standIn(hostname: string, protocol = 'http:'): void {
  Object.defineProperty(globalThis, 'location', {
    value: { hostname, protocol, host: hostname, origin: `${protocol}//${hostname}` },
    configurable: true,
    writable: true,
  });
}

afterEach(() => {
  Object.defineProperty(globalThis, 'location', {
    value: REAL_LOCATION,
    configurable: true,
    writable: true,
  });
  vi.resetModules();
});

describe('derivedBases', () => {
  it('sends every service through the one origin on a hidden-service host', async () => {
    const { derivedBases } = await import('./config.js');

    expect(
      derivedBases({
        hostname: 'abcdefghij234567.onion',
        protocol: 'http:',
        host: 'abcdefghij234567.onion',
        origin: 'http://abcdefghij234567.onion',
      }),
    ).toEqual({
      api: 'http://abcdefghij234567.onion/api',
      media: 'http://abcdefghij234567.onion/media',
      relay: 'ws://abcdefghij234567.onion/relay',
    });
  });

  it('keeps the socket secure when the page is', async () => {
    const { derivedBases } = await import('./config.js');

    expect(
      derivedBases({ hostname: 'x.onion', protocol: 'https:', host: 'x.onion', origin: 'https://x.onion' })?.relay,
    ).toBe('wss://x.onion/relay');
  });

  it('rebuilds a missing origin out of the protocol and the host', async () => {
    const { derivedBases } = await import('./config.js');

    expect(derivedBases({ hostname: 'y.onion', protocol: 'http:', host: 'y.onion:8080' })).toEqual({
      api: 'http://y.onion:8080/api',
      media: 'http://y.onion:8080/media',
      relay: 'ws://y.onion:8080/relay',
    });
  });

  it('leaves every ordinary host alone', async () => {
    const { derivedBases } = await import('./config.js');

    expect(derivedBases({ hostname: 'localhost' })).toBeNull();
    expect(derivedBases({ hostname: '1nky.com' })).toBeNull();
    // Not a suffix match on the word — a lookalike host is an ordinary host.
    expect(derivedBases({ hostname: 'onion.example.com' })).toBeNull();
    expect(derivedBases({ hostname: 'notreallyonion' })).toBeNull();
    expect(derivedBases(undefined)).toBeNull();
    expect(derivedBases(null)).toBeNull();
  });
});

describe('the three exported bases', () => {
  it('come off the address bar when the page is a hidden service', async () => {
    standIn('7xqfhpv2kd3jm4nb.onion');
    vi.resetModules();

    const config = await import('./config.js');

    expect(config.API_BASE).toBe('http://7xqfhpv2kd3jm4nb.onion/api');
    expect(config.MEDIA_BASE).toBe('http://7xqfhpv2kd3jm4nb.onion/media');
    expect(config.RELAY_WS_URL).toBe('ws://7xqfhpv2kd3jm4nb.onion/relay');
    expect(config.SAME_ORIGIN_SERVICES).toBe(true);
  });

  it('stay on the built-in defaults everywhere else', async () => {
    standIn('localhost');
    vi.resetModules();

    const config = await import('./config.js');

    expect(config.API_BASE).toBe('http://localhost:3001');
    expect(config.MEDIA_BASE).toBe('http://localhost:3002');
    expect(config.RELAY_WS_URL).toBe('ws://localhost:7777');
    expect(config.SAME_ORIGIN_SERVICES).toBe(false);
  });

  it('leaves everything that is not an address alone', async () => {
    standIn('deadbeefdeadbeef.onion');
    vi.resetModules();

    const config = await import('./config.js');

    // The work targets and the upload ceilings are build-time facts about the
    // wall's policy, not about where the visitor came in.
    expect(config.POW_BITS.new).toBe(18);
    expect(config.MAX_UPLOAD_BYTES).toBe(5 * 1024 * 1024);
    expect(config.FULL_MAX_EDGE).toBe(2048);
  });
});
