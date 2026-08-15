import { fileURLToPath } from "node:url";

import preact from "@astrojs/preact";
import { defineConfig } from "astro/config";

export default defineConfig({
  integrations: [preact()],
  outDir: fileURLToPath(new URL("./dist", import.meta.url)),
  output: "static",
  publicDir: fileURLToPath(new URL("./public", import.meta.url)),
  root: fileURLToPath(new URL(".", import.meta.url)),
  site: "https://music.the816.com",
  srcDir: fileURLToPath(new URL("./src", import.meta.url)),
  trailingSlash: "always",
  vite: {
    build: {
      sourcemap: false,
    },
    resolve: {
      // TypeScript uses the narrow local Plot declaration facade; Vite must still bundle the
      // exact-pinned runtime instead of treating that declaration-only module as JavaScript.
      alias: {
        "@observablehq/plot": fileURLToPath(
          new URL("../node_modules/@observablehq/plot/src/index.js", import.meta.url),
        ),
      },
    },
  },
});
