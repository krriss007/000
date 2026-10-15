import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const webRoot = import.meta.dirname;

export default defineConfig({
  root: webRoot,
  plugins: [react()],
  resolve: {
    alias: {
      '@shared': path.resolve(webRoot, '../shared'),
    },
  },
  build: {
    outDir: path.resolve(webRoot, '../web-dist'),
    emptyOutDir: true,
    target: 'es2020',
    sourcemap: false,
    chunkSizeWarningLimit: 900,
  },
  server: {
    host: true,
    port: 5173,
    // the shared/ folder lives outside the vite root
    fs: { allow: [path.resolve(webRoot, '..')] },
    proxy: {
      '/api': {
        target: process.env.APP_SERVER_URL || 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
});
