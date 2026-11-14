import { defineConfig } from 'tsup';

export default defineConfig([
    {
        entry: { index: 'src/index.ts' },
        // Dual, ESM first: an ESM host that leaves packages external cannot take
        // a named import from a CJS build with getter-defined exports.
        format: ['esm', 'cjs'],
        dts: true,
        sourcemap: true,
        clean: true,
        platform: 'node',
        target: 'node22',
        // `ws` is the one runtime dependency and is never bundled.
        external: [/^node:/, 'ws'],
        treeshake: true,
    },
    {
        entry: { cli: 'src/cli.ts' },
        format: ['esm'],
        sourcemap: true,
        clean: false,
        platform: 'node',
        target: 'node22',
        external: [/^node:/, 'ws'],
        banner: { js: '#!/usr/bin/env node' },
    },
]);
