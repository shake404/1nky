import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Bodega is the only shipped display face — and it is self-hosted from
 * /public/fonts, never a CDN. This test pins both halves of that contract so a
 * refactor cannot silently drop the font or re-introduce a third-party URL.
 */
const cssPath = resolve(import.meta.dirname, '../styles/global.css');
const css = readFileSync(cssPath, 'utf8');

describe('global.css ships Bodega as a self-hosted display face', () => {
  it('declares @font-face blocks for both Bodega weights', () => {
    expect(css).toMatch(/@font-face\s*{[^}]*font-family:\s*'Bodega Plain'[^}]*}/);
    expect(css).toMatch(/@font-face\s*{[^}]*font-family:\s*'Bodega Striped'[^}]*}/);
  });

  it('points the src at self-hosted woff2 files, never a CDN', () => {
    expect(css).toMatch(/url\('\/fonts\/Bodega-Plain\.woff2'\)/);
    expect(css).toMatch(/url\('\/fonts\/Bodega-Striped\.woff2'\)/);
    // No http(s) font URLs anywhere.
    expect(css).not.toMatch(/url\(['"]https?:\/\/[^)]*\.(woff2|woff|ttf)/);
  });

  it('uses font-display: swap so text never hides during the swap', () => {
    const plain = css.match(/@font-face\s*{[^}]*'Bodega Plain'[^}]*}/)?.[0] ?? '';
    const striped = css.match(/@font-face\s*{[^}]*'Bodega Striped'[^}]*}/)?.[0] ?? '';
    expect(plain).toContain('font-display: swap');
    expect(striped).toContain('font-display: swap');
  });

  it('puts Bodega Plain in the display stack and Striped on the wordmark', () => {
    expect(css).toContain("'Bodega Plain'");
    expect(css).toContain("'Bodega Striped'");
    // The big hero wordmark accent uses the striped variant.
    expect(css).toMatch(/\.hero__mark[^{]*{[^}]*--display-striped/);
  });
});