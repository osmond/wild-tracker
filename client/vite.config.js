import { defineConfig } from 'vite';

export default defineConfig({
  base: '/',

  // Proxy all /api/* calls to the Express backend (strips /api prefix)
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
