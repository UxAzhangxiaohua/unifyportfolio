import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 8188,
    // Extra hostnames for the dev server (e.g. a tunnel domain), comma-separated — kept out of the repo
    allowedHosts: (process.env.ALLOWED_HOSTS ?? '').split(',').map((h) => h.trim()).filter(Boolean),
    proxy: {
      '/api': 'http://localhost:8189',
    },
  },
});
