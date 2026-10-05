// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { defineConfig } from 'vitest/config';
import path from 'node:path';
export default defineConfig({
  esbuild: { jsx: 'automatic' },
  plugins: [{name: 'synthetic-translation-port', resolveId(id) { if(id === 'gt-react') return '\0eval-gt-react'; }, load(id) { if(id === '\0eval-gt-react') return 'export const useGT=()=>t=>t; export const msg=t=>t;'; }}],
  test: { include: ['eval-manual-sync.test.tsx'], environment: 'jsdom',
    setupFiles: ['@testing-library/jest-dom/vitest'],
    pool: 'forks', poolOptions: { forks: { singleFork: true } } },
  resolve: { alias: { '@': path.resolve('.') } },
  css: { postcss: { plugins: [] } },
});
