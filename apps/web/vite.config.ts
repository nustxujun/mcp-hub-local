import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const rootPkg = JSON.parse(readFileSync(resolve(__dirname, '../../package.json'), 'utf-8'));

export default defineConfig({
  plugins: [react()],
  base: '/app/',
  define: {
    __APP_VERSION__: JSON.stringify(rootPkg.version),
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3000',
      '/w': 'http://localhost:3000',
    },
  },
  build: {
    outDir: 'dist',
  },
});
