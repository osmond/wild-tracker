import { defineConfig } from 'vite';

export default defineConfig({
  base: '/',

  // Proxy all /api/* calls to the Express backend (preserves /api prefix)
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
