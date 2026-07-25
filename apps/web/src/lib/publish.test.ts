import { describe, expect, it } from 'vitest';
import { powShortfall } from './publish.js';

describe('powShortfall', () => {
  it('reads the required difficulty out of a relay pow rejection', () => {
    // The exact shape the write-policy sends after a relay restart forgets you.
    expect(powShortfall('pow: committed difficulty 13 is below the required 18', 13)).toBe(18);
  });

  it('handles the missing-nonce variant naming only the target', () => {
    expect(powShortfall('pow: missing committed difficulty; add a nonce tag targeting 18 bits', 13)).toBe(18);
  });

  it('is null when the ask is not higher than what we tried', () => {
    expect(powShortfall('pow: difficulty 8 does not meet the committed target 8', 13)).toBeNull();
  });

  it('is null for non-pow rejections', () => {
    expect(powShortfall('blocked: this tag is banned', 13)).toBeNull();
    expect(powShortfall('rate limited', 13)).toBeNull();
  });

  it('refuses to chase an absurd difficulty past the ceiling', () => {
    expect(powShortfall('pow: required 99', 13)).toBeNull();
  });
});
