/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const apiTarget = process.env.VITE_PROXY_TARGET ?? 'http://localhost:4000';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    // Same-origin API calls in dev: /api/* -> the backend (without the /api prefix), so no CORS setup is needed.
    proxy: { '/api': { target: apiTarget, changeOrigin: true, rewrite: (path) => path.replace(/^\/api/, '') } },
  },
  preview: { port: 4173, proxy: { '/api': { target: apiTarget, changeOrigin: true, rewrite: (path) => path.replace(/^\/api/, '') } } },
  test: {
    environment: 'jsdom',
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/**/*.test.{ts,tsx}'],
    css: false,
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
