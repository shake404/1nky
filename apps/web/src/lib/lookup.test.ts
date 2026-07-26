import { afterEach, describe, expect, it, vi } from 'vitest';

// fetchProfile reads the relay singleton; mock it so lookupTarget's tests stay
// pure and instant rather than opening a real connection.
vi.mock('./relay.js', () => ({
  relay: {
    query: vi.fn(async (filters: { authors?: string[] }[]) => {
      const author = filters[0]?.authors?.[0];
      if (author === 'a'.repeat(64)) {
        return [
          {
            kind: 0,
            pubkey: author,
            created_at: 1,
            content: JSON.stringify({ name: 'FASE', avatar_sha256: 'b'.repeat(64) }),
            id: '',
            sig: '',
            tags: [],
          },
        ];
      }
      return [];
    }),
    publish: vi.fn(),
    watch: vi.fn(() => () => {}),
    connect: vi.fn(),
  },
}));

const { resolveLookupInput, lookupTarget } = await import('./lookup.js');

const MARK = 'a'.repeat(64);
const NOBODY = 'c'.repeat(64);

afterEach(() => vi.restoreAllMocks());

describe('resolveLookupInput', () => {
  it('takes the bare 64-hex id', () => {
    expect(resolveLookupInput(MARK)).toBe(MARK);
  });

  it('takes a full writer link', () => {
    expect(resolveLookupInput(`https://1nky.com/w/${MARK}`)).toBe(MARK);
  });

  it('takes a bare writer path', () => {
    expect(resolveLookupInput(`/w/${MARK}`)).toBe(MARK);
  });

  it('takes a full crew link', () => {
    expect(resolveLookupInput(`https://1nky.com/crew/${MARK}`)).toBe(MARK);
  });

  it('takes a bare crew path', () => {
    expect(resolveLookupInput(`/crew/${MARK}`)).toBe(MARK);
  });

  it('lowercases mixed-case hex', () => {
    expect(resolveLookupInput(MARK.toUpperCase())).toBe(MARK);
  });

  it('tolerates surrounding whitespace and a trailing slash', () => {
    expect(resolveLookupInput(`  /w/${MARK}/  `)).toBe(MARK);
  });

  it('rejects a mark — it cannot be reversed to an id', () => {
    expect(resolveLookupInput('aa11bb')).toBeNull();
  });

  it('rejects a plain name', () => {
    expect(resolveLookupInput('FASE')).toBeNull();
  });

  it('rejects empty input', () => {
    expect(resolveLookupInput('   ')).toBeNull();
  });

  it('rejects garbage', () => {
    expect(resolveLookupInput('this is not a link at all')).toBeNull();
  });
});

describe('lookupTarget', () => {
  it('reports invalid when the input does not parse to an id', async () => {
    const outcome = await lookupTarget('not a link');
    expect(outcome).toEqual({ status: 'invalid' });
  });

  it('reports not-found when the id parses but nothing has ever posted there', async () => {
    const outcome = await lookupTarget(NOBODY);
    expect(outcome).toEqual({ status: 'not-found' });
  });

  it('resolves a known id to its row', async () => {
    const outcome = await lookupTarget(`/w/${MARK}`);
    expect(outcome).toEqual({
      status: 'found',
      pubkey: MARK,
      name: 'FASE',
      mark: expect.any(String),
      avatarSha256: 'b'.repeat(64),
    });
  });

  it('resolves a crew link the same way as a writer link', async () => {
    const outcome = await lookupTarget(`/crew/${MARK}`);
    expect(outcome).toEqual({
      status: 'found',
      pubkey: MARK,
      name: 'FASE',
      mark: expect.any(String),
      avatarSha256: 'b'.repeat(64),
    });
  });
});
