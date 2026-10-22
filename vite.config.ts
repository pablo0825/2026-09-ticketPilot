import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({
    plugins: [tailwindcss()],
    root: "src/local/react",
    base: "/",
    build: {
        outDir: "../../../dist/react",
        emptyOutDir: true,
    },
    esbuild: { jsx: "automatic" },
});
