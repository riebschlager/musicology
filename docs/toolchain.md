# Toolchain

Musicology is a single ECMAScript-module package built with strict TypeScript on Node.js 24. The `.node-version` file pins the Node 24 major line while `package.json` rejects other Node major versions. pnpm is pinned exactly because its lockfile format and install behavior are part of the reproducible toolchain.

The development dependency set is intentionally small:

- TypeScript and the matching Node 24 type definitions provide compilation and static checking.
- Node 24's built-in TypeScript support runs the tests directly with the built-in test runner, avoiding a separate test framework or test-runtime dependency. Test imports use `.ts` extensions; TypeScript checks them and rewrites source extensions when emitting JavaScript.
- Biome provides both formatting and linting in one dependency. Its check commands do not rewrite files and return nonzero exit codes when violations are found.

`pnpm quality` is the aggregate local quality gate. It checks formatting and linting, type-checks the complete source and test tree, runs tests, and performs a production build with external source maps.
