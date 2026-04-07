import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 8188,
    allowedHosts: ['pf.zsy.ch'],
    proxy: {
      '/api': 'http://localhost:8189',
    },
  },
});
