/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

interface ImportMetaEnv {
  readonly VITE_RELAY_WS_URL?: string;
  readonly VITE_API_BASE?: string;
  readonly VITE_MEDIA_BASE?: string;
  readonly VITE_POW_BITS_NEW?: string;
  readonly VITE_POW_BITS_POST?: string;
  readonly VITE_POW_BITS_REACTION?: string;
  readonly VITE_MAX_UPLOAD_MB?: string;
  /** Set to "1" to reveal the settings diagnostics panel. Hidden by default. */
  readonly VITE_SHOW_FLAGS?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
