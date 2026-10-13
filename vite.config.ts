import { defineConfig } from "vite";

export default defineConfig({
    root: "src/local/react",
    base: "/",
    build: {
        outDir: "../../../dist/react",
        emptyOutDir: true,
    },
    esbuild: { jsx: "automatic" },
});
