import { defineConfig } from "vite";
import { resolve } from "path";

// `base: "./"` makes every built asset reference relative, so the extension
// works no matter where it's hosted: domain root, a custom domain, or a
// GitHub Pages *project* site served from a sub-path like
// https://<user>.github.io/<repo>/. Do not change this to an absolute "/"
// path unless you know your extension will always live at a domain root.
export default defineConfig({
  base: "./",
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        viewer: resolve(__dirname, "viewer.html"),
        background: resolve(__dirname, "background.html"),
      },
    },
  },
});
