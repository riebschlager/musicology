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
  },
});
