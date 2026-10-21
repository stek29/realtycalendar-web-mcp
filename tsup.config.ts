import { defineConfig } from 'tsup'

export default defineConfig({
  entry: { main: 'src/cli/main.ts' },
  format: 'esm',
  target: 'node22',
  platform: 'node',
  clean: true,
  sourcemap: true,
  banner: { js: '#!/usr/bin/env node' },
})
