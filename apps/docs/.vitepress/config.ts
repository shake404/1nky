import { defineConfig } from 'vitepress'

// No analytics. No telemetry. No third-party scripts. Ever.
// If you find one in the built output, that's a bug — report it: /security
export default defineConfig({
  title: '1NKY docs',
  titleTemplate: ':title — 1NKY docs',
  description:
    'How 1NKY works, what we do not collect, and how to check that for yourself. Anonymous, registration-free platform for graffiti writers.',
  lang: 'en-US',
  cleanUrls: true,
  appearance: 'dark',
  ignoreDeadLinks: true,
  lastUpdated: false,
  head: [
    ['meta', { name: 'referrer', content: 'no-referrer' }],
    ['meta', { name: 'robots', content: 'index, follow' }],
    ['meta', { name: 'color-scheme', content: 'dark light' }],
  ],
  themeConfig: {
    siteTitle: '1NKY docs',
    outline: [2, 3],
    nav: [
      { text: 'Start Here', link: '/how-it-works' },
      { text: 'Using It', link: '/guide/your-tag' },
      { text: 'Privacy & Trust', link: '/privacy/no-logs' },
      { text: 'Roadmap', link: '/roadmap' },
      { text: 'For the Nerds', link: '/for-the-nerds' },
      // Plain text link, not themeConfig.socialLinks: the default theme's social
      // icons fall back to fetching api.iconify.design at runtime when the mask
      // isn't bundled. A third-party request would break the promise on
      // /privacy/no-logs. An anchor tag costs nothing and fetches nothing.
      { text: 'GitHub', link: 'https://github.com/bodegga/1nky' },
    ],
    sidebar: [
      {
        text: 'Start Here',
        collapsed: false,
        items: [
          { text: 'What 1NKY is', link: '/' },
          { text: 'How it works', link: '/how-it-works' },
        ],
      },
      {
        text: 'Using It',
        collapsed: false,
        items: [
          { text: 'Your tag', link: '/guide/your-tag' },
          { text: 'Putting work up', link: '/guide/posting' },
          { text: 'Boards, beef & happenings', link: '/guide/boards' },
          { text: 'Crews', link: '/guide/crews' },
          { text: 'Shout-outs & messages', link: '/guide/talking' },
          { text: 'Keeping it clean', link: '/guide/moderation' },
          { text: 'Install it', link: '/guide/install' },
        ],
      },
      {
        text: 'Privacy & Trust',
        collapsed: false,
        items: [
          { text: 'No logs, by architecture', link: '/privacy/no-logs' },
          { text: 'The onion mirror', link: '/privacy/onion' },
          { text: 'Opsec for writers', link: '/privacy/opsec' },
          { text: 'Transparency & warrant canary', link: '/privacy/transparency' },
          { text: 'Security disclosure', link: '/security' },
        ],
      },
      {
        text: 'Roadmap & Feedback',
        collapsed: false,
        items: [
          { text: 'Roadmap', link: '/roadmap' },
          { text: 'Bugs & feature requests', link: '/feedback' },
        ],
      },
      {
        text: 'Legal',
        collapsed: false,
        items: [
          { text: 'Terms of use', link: '/legal/terms' },
          { text: 'Privacy policy', link: '/legal/privacy-policy' },
          { text: 'DMCA', link: '/legal/dmca' },
        ],
      },
      {
        text: 'For the Nerds',
        collapsed: false,
        items: [{ text: 'The honest technical page', link: '/for-the-nerds' }],
      },
    ],
    editLink: undefined,
    // Local index built at build time — not a hosted search service.
    search: { provider: 'local' },
    footer: {
      message:
        'No accounts. No emails. No logs. Docs are public so you can check the claims instead of trusting them.',
      copyright: '1NKY — docs.1nky.com',
    },
  },
})
