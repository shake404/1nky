# Vendored face-detection assets

These files exist so the **Blur faces** toggle in the post flow works with
**nothing loading from a CDN at runtime**. Every byte the blur tool needs is
served from this origin, from this folder. If you ever find yourself adding a
`https://cdn.jsdelivr.net/...` path to `FilesetResolver`, stop: that would leak
a request to a third party the moment a writer flips the toggle on, which is
exactly the thing this folder buys back.

Nothing here is loaded until the writer switches the toggle on for the first
time (`src/lib/blur.ts` dynamic-imports the library and creates the detector
lazily), and nothing here is precached by the service worker — see
`globIgnores: ['models/**']` in `vite.config.ts`.

## blaze_face_short_range.tflite

BlazeFace (short range) — the front-camera-distance face detector.

- Source: `https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite`
- Model card: https://ai.google.dev/edge/mediapipe/solutions/vision/face_detector
- Variant: `float16`, revision `1`
- Fetched: 2026-07-25
- Size: 229,746 bytes
- sha256: `b4578f35940bf5a1a655214a1cce5cab13eba73c1297cd78e1a04c2380b0152f`
- Licence: Apache-2.0 (Google MediaPipe model release)

## wasm/

The MediaPipe Tasks Vision WebAssembly runtime, copied verbatim out of the npm
package rather than downloaded — same bytes, no network trust needed:

    cp node_modules/@mediapipe/tasks-vision/wasm/vision_wasm_internal.js \
       node_modules/@mediapipe/tasks-vision/wasm/vision_wasm_internal.wasm \
       node_modules/@mediapipe/tasks-vision/wasm/vision_wasm_nosimd_internal.js \
       node_modules/@mediapipe/tasks-vision/wasm/vision_wasm_nosimd_internal.wasm \
       apps/web/public/models/wasm/

- Package: `@mediapipe/tasks-vision@0.10.35` (npm), Apache-2.0
- Fetched: 2026-07-25
- Both the SIMD and the no-SIMD build are vendored because
  `FilesetResolver.forVisionTasks()` feature-detects at load time and picks one;
  shipping only the SIMD pair would silently break older devices.
- The two `vision_wasm_module_internal.*` files from the package are **not**
  vendored — they belong to the lower-level graph-runner API, which we do not use.

| file | bytes | sha256 |
|---|---|---|
| `vision_wasm_internal.js` | 322,044 | `e7fd9858e8e8f221d9b96eddc11f8e077f263e0b7bbd79d3cbe882b134274f8c` |
| `vision_wasm_internal.wasm` | 11,153,617 | `6a5c64584c2ab61c763b6e204afbdbc7ce1caf7f5216187322bca8df94f646bc` |
| `vision_wasm_nosimd_internal.js` | 321,847 | `438d1fe8ff7f4d946025bc211c291543c037d8a3785ed4eee60f1f521b236296` |
| `vision_wasm_nosimd_internal.wasm` | 10,481,398 | `8a3092d34c79d3f57e6ba8592105e8a90f6b07c27891ffecd14cca428bfd3e31` |

## Refreshing them

After bumping `@mediapipe/tasks-vision` in `apps/web/package.json`, re-run the
copy above and re-fetch the `.tflite` with `curl -L -o`. Then update the sizes,
hashes and the fetched date in this file — they are the only record of where
these binaries came from.
