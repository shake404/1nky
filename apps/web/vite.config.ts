import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

// No analytics, no third-party scripts, no CDN fonts. Everything ships from
// this origin (hard rule: nothing about a visitor leaves the box).
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      // 'prompt', not 'autoUpdate': a silent auto-swap can land mid-upload
      // or mid-post and yank the tab out from under a writer. Prompt mode
      // installs the new build in the background and waits for a tap — see
      // src/lib/registerAppUpdates.ts, which surfaces that wait as a toast.
      registerType: 'prompt',
      includeAssets: ['favicon.svg', 'icon.svg', 'apple-touch-icon.png'],
      manifest: {
        name: '1NKY',
        short_name: '1NKY',
        description: 'Put your work up. No name, no number, no trail.',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        orientation: 'portrait',
        background_color: '#0c0a11',
        theme_color: '#0c0a11',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: 'icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          { src: 'icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        // The vendored face-detection runtime is ~22MB of WebAssembly plus its
        // loader scripts, and a writer who never flips the "Blur faces" switch
        // must never pay for it. It is served from this origin either way (hard
        // rule: nothing loads from a CDN) — it is just fetched on demand rather
        // than installed with the app. Keeping it out of the precache manifest
        // also keeps the build honest about workbox's file-size ceiling.
        // `cities.json` is the same bargain in miniature: ~110KB of city names
        // behind the "Where" picker, fetched from this origin the first time
        // somebody names a city and never for anyone who does not. (`.json` is
        // not in globPatterns above either — this is the explicit half of that,
        // so nobody adds `json` to the patterns and silently ships it.)
        globIgnores: ['models/**', 'cities.json'],
        // Content-addressed media is immutable; cache it hard, but never
        // cache API/relay traffic.
        runtimeCaching: [
          {
            urlPattern: /\/media\/.*/i,
            handler: 'CacheFirst',
            options: {
              cacheName: '1nky-flicks',
              expiration: { maxEntries: 300, maxAgeSeconds: 60 * 60 * 24 * 30 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
      devOptions: { enabled: false },
    }),
  ],
  build: {
    target: 'es2022',
    sourcemap: false,
  },
  worker: {
    format: 'es',
  },
});
