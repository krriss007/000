import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const webRoot = import.meta.dirname;

/**
 * DEV TOOL — builds the client as a single IIFE bundle so tools/dom-test.mjs can
 * execute it inside jsdom (jsdom cannot run ES modules) and assert what the UI
 * actually renders against the mock backend.
 */
export default defineConfig({
  root: webRoot,
  plugins: [react()],
  resolve: {
    alias: { '@shared': path.resolve(webRoot, '../shared') },
  },
  define: { 'process.env.NODE_ENV': '"production"' },
  build: {
    outDir: path.resolve(webRoot, '../.tmp-domtest'),
    emptyOutDir: true,
    target: 'es2019',
    lib: {
      entry: path.resolve(webRoot, 'src/main.tsx'),
      name: 'AetherCatalogTest',
      formats: ['iife'],
      fileName: () => 'app.iife.js',
    },
    rollupOptions: {
      output: { inlineDynamicImports: true },
    },
  },
});
