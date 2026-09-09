import path from 'node:path';
import { createRequire } from 'node:module';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// `three`'s two ES builds, as absolute paths. Neither is reachable as a bare
// specifier: the package's exports map publishes only `.` (→ three.module.js)
// and `./webgpu`, so `three/build/...` cannot be resolved — and returning an
// absolute path from the resolver below is what keeps the alias from matching
// its own output a second time.
const THREE_BUILD_DIR = path.dirname(createRequire(import.meta.url).resolve('three'));
const THREE_WEBGPU = path.join(THREE_BUILD_DIR, 'three.webgpu.js');
const THREE_CLASSIC = path.join(THREE_BUILD_DIR, 'three.module.js');

/**
 * The two importers that need the **classic** `three` build
 * (`gaussian_splats.md` §4.1):
 *
 * - `scene/splatLayer.ts` — `WebGLRenderer` lives only there; `three/webgpu`
 *   does not export it.
 * - `@sparkjsdev/spark` — it drives that `WebGLRenderer` and writes its GLSL
 *   `splatDefines` include into `THREE.ShaderChunk`, which `three/webgpu` also
 *   does not export, so Spark would throw on its first render.
 */
const NEEDS_CLASSIC_THREE = /(?:@sparkjsdev[\\/]spark|[\\/]scene[\\/]splatLayer\.ts$)/;

export default defineConfig({
  plugins: [react()],
  worker: {
    format: 'es',
  },
  optimizeDeps: {
    // Nothing in the three family — nor Spark — is pre-bundled, so **every**
    // bare `three` import goes through the alias resolver below, in dev exactly
    // as in the production build. This is what keeps the two builds sharing one
    // `three.core.js` instance in dev: pre-bundling `three` produces a chunk
    // with its own copy of the core, and Spark's
    // `camera instanceof THREE.OrthographicCamera` check would then fail against
    // the viewport's cameras, silently breaking the orthographic elevations
    // (`gaussian_splats.md` §4.3). Each of these is a single ESM file, so
    // serving them unbundled costs a request apiece, not a request storm.
    exclude: ['three', 'three/webgpu', 'three/tsl', '@sparkjsdev/spark'],
  },
  resolve: {
    // Use a single three.js *core* across the whole app. The renderer needs the
    // `three/webgpu` build (WebGPURenderer + node system, spec §2.3), so bare
    // `three` resolves to it — scene objects and the OrbitControls /
    // TransformControls addons then share that one build instead of loading a
    // second copy. The regex matches only the exact specifier, leaving
    // `three/webgpu`, `three/tsl`, and `three/addons/*` to resolve normally.
    //
    // The splat layer and Spark are the two documented exceptions and get the
    // classic build instead (`gaussian_splats.md` §4.1). That is an
    // **importer-conditional** rule, which only a `customResolver` can express —
    // a second `find` entry cannot see who is importing. It is safe because both
    // builds import their core classes from the same `three.core.js`: there is
    // exactly one `Object3D`/`PerspectiveCamera`/`OrthographicCamera` class in
    // the bundle, so the viewport's camera objects work in both renderers and
    // `TransformControls` attaches to a splat anchor created by the other build
    // (§4.3).
    alias: [
      {
        find: /^three$/,
        replacement: THREE_WEBGPU,
        customResolver(updatedId, importer) {
          return importer != null && NEEDS_CLASSIC_THREE.test(importer) ? THREE_CLASSIC : updatedId;
        },
      },
    ],
  },
});
