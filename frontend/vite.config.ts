import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 8188,
    allowedHosts: ['your-domain.example'],
    proxy: {
      '/api': 'http://localhost:3001',
    },
  },
});
