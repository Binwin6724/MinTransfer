import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  root: 'src',
  base: './',
  plugins: [
    react(),
    // The dev server injects an inline HMR preamble; the strict CSP applies to production builds.
    {
      name: 'dev-csp',
      apply: 'serve',
      transformIndexHtml: (html) => html.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, ''),
    },
  ],
  build: { outDir: '../dist/renderer', emptyOutDir: true, target: 'chrome130' },
  server: { port: 5198, strictPort: true },
});
