import { defineConfig } from 'vitest/config'

// Separate from vite.config.ts: Vitest bundles its own Vite major, so sharing plugin types breaks `tsc -b`.
// JSX is compiled by esbuild using tsconfig (react-jsx); no React plugin is needed for tests.
export default defineConfig({
  test: { environment: 'jsdom', setupFiles: ['./src/test-setup.ts'], css: false },
})
