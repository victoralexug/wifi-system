import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { '/api': 'http://localhost:4000' },
  },
  build: {
    target: 'es2020',
    // The portal loads on phones over weak signal, so keep it to one small bundle.
    chunkSizeWarningLimit: 250,
  },
});
