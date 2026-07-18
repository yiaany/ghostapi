import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: "src/landing",
  base: "/landing/",
  plugins: [react()],
  build: {
    outDir: "../../dist/landing",
    emptyOutDir: false
  }
});
