import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  worker: {
    format: 'es',
  },
  resolve: {
    // Use a single three.js instance across the whole app. The renderer needs
    // the `three/webgpu` build (WebGPURenderer + node system, spec §2.3); alias
    // bare `three` to it so scene objects and the OrbitControls/TransformControls
    // addons share that one build instead of loading a second core copy — which
    // would break cross-build interop and double the bundle. The regex matches
    // only the exact specifier, leaving `three/webgpu`, `three/tsl`, and
    // `three/addons/*` to resolve normally.
    alias: [{ find: /^three$/, replacement: 'three/webgpu' }],
  },
});
