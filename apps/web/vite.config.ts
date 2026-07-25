import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

// No analytics, no third-party scripts, no CDN fonts. Everything ships from
// this origin (hard rule: nothing about a visitor leaves the box).
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
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
        globIgnores: ['models/**'],
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
