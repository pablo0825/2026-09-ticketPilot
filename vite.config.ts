import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({
    plugins: [tailwindcss()],
    root: "src/gui",
    base: "/",
    build: {
        outDir: "../../dist/react",
        emptyOutDir: true,
    },
    esbuild: { jsx: "automatic" },
});
