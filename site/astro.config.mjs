// @ts-check
import { defineConfig } from "astro/config";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

export default defineConfig({
  site: "https://hemvault.sayar.one",
  vite: {
    plugins: [tailwindcss()],
    server: {
      fs: {
        allow: [repoRoot],
      },
    },
  },
});
