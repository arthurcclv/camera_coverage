import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // The gsplat sort worker ships inside the playcanvas package and is pulled in
  // as an ES-module worker, so Vite must emit workers in that format (spec §8.2).
  worker: {
    format: 'es',
  },
  optimizeDeps: {
    // playcanvas is large; pre-bundling it keeps dev-server reloads workable.
    include: ['playcanvas'],
  },
});
