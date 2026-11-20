import { defineConfig } from 'vite';

// `npm run dev` serves on :5173 and forwards API + socket calls to the Python server on :8000.
export default defineConfig({
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:8000',
      '/ws': { target: 'ws://127.0.0.1:8000', ws: true },
    },
  },
});
