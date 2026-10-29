import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { stepAssets } from "./scripts/step-assets";

const embed = process.env.VOXELSPY_EMBED_BUILD === "1";
export default defineConfig(({ isSsrBuild }) => ({
  ...(embed ? { base: "./" } : {}),
  plugins: [react(), ...(!isSsrBuild ? [stepAssets()] : [])],
  build: {
    sourcemap: true,
    ...(embed
      ? { outDir: "dist-embed", rollupOptions: { input: "embed.html" } }
      : {}),
  },
}));
