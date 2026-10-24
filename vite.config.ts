import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';

/** package.json is the one place the version lives; the About dialog reads it from here. */
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

export default defineConfig({
  base: './',
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  server: { port: 5180, strictPort: false },
  build: {
    target: 'es2022',
    outDir: 'dist',
    sourcemap: true,
  },
});
