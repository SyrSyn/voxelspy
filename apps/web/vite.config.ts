import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { stepAssets } from "./scripts/step-assets";

export default defineConfig(({ isSsrBuild }) => ({
  plugins: [react(), ...(!isSsrBuild ? [stepAssets()] : [])],
  build: {
    sourcemap: true,
  },
}));
