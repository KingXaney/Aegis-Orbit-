/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { port: 5173, strictPort: false },
  build: {
    chunkSizeWarningLimit: 4000,
    rollupOptions: {
      output: {
        // A function, not a name list: listing recharts also pulled React (which it depends on) into
        // its chunk, so every page had to preload the simulator's charts.
        manualChunks(id) {
          // Vite's dynamic-import helper otherwise lands in the cesium chunk, making every lazy import
          // (and so every page) load Cesium.
          if (id.includes('vite/preload-helper')) return 'react';
          if (!id.includes('node_modules')) return undefined;
          if (/node_modules\/(react|react-dom|scheduler)\//.test(id)) return 'react';
          if (id.includes('node_modules/cesium') || id.includes('node_modules/@cesium')) return 'cesium';
          if (id.includes('node_modules/three/')) return 'three';
          // Recharts and the packages only it uses. Shared ones (use-sync-external-store, which
          // zustand also uses; d3-array, which d3-geo also uses) go to vendor, or Rollup would put
          // them in this chunk and the explorer would download the simulator's charts.
          if (/node_modules\/(recharts|victory-vendor|@reduxjs|react-redux|redux|reselect|immer|decimal\.js-light|es-toolkit|eventemitter3|tiny-invariant|clsx|d3-(?!array|geo))/.test(id)) {
            return 'recharts';
          }
          if (/node_modules\/(zustand|use-sync-external-store|d3-array|d3-geo|topojson-client|satellite\.js)\//.test(id)) return 'vendor';
          // Anything else stays with what imports it (Cesium's own dependencies, with Cesium).
          return undefined;
        },
      },
    },
  },
  optimizeDeps: { include: ['cesium', 'three'] },
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
  },
});
