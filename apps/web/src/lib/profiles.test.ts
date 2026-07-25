import { KINDS, PROFILE_BIO_MAX } from '@1nky/protocol';
import { describe, expect, it } from 'vitest';
import { profileTemplate } from './profiles.js';

describe('profile edit builds a kind-0 with the about field', () => {
  it('serialises the bio as `about`', () => {
    const template = profileTemplate({ name: 'SHOCK' }, { bio: 'rooftops and freight' });

    expect(template.kind).toBe(KINDS.PROFILE);
    const parsed = JSON.parse(template.content) as Record<string, string>;
    expect(parsed['name']).toBe('SHOCK');
    expect(parsed['about']).toBe('rooftops and freight');
  });

  it('omits about when the bio is left empty', () => {
    const template = profileTemplate({ name: 'OMENS' }, { bio: '   ' });
    const parsed = JSON.parse(template.content) as Record<string, string>;
    expect(parsed['name']).toBe('OMENS');
    expect(parsed).not.toHaveProperty('about');
  });

  it('keeps the city alongside the bio', () => {
    const template = profileTemplate({ name: 'KEMS' }, { bio: 'freights', city: 'Oakland' });
    const parsed = JSON.parse(template.content) as Record<string, string>;
    expect(parsed['about']).toBe('freights');
    expect(parsed['city']).toBe('oakland');
  });

  it('respects the bio character ceiling', () => {
    const within = profileTemplate({ name: 'X' }, { bio: 'a'.repeat(PROFILE_BIO_MAX) });
    expect(JSON.parse(within.content)['about']).toBe('a'.repeat(PROFILE_BIO_MAX));

    expect(() => profileTemplate({ name: 'X' }, { bio: 'a'.repeat(PROFILE_BIO_MAX + 1) })).toThrow();
  });

  it('says nothing a writer should not read', () => {
    try {
      profileTemplate({ name: '' });
      expect.unreachable();
    } catch (error) {
      const message = (error as Error).message.toLowerCase();
      for (const word of ['nostr', 'nip', 'kind', 'event', 'relay']) {
        expect(message).not.toContain(word);
      }
    }
  });
});
