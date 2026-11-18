import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The assistant is built for its prefix. The root of the origin — `/api`,
// `/assets`, `/_build` — belongs to the generated application, so nothing here
// may be root-absolute: `base` puts every asset under `/chat/`, and the client
// reaches its own API through `import.meta.env.BASE_URL`.
const base = `${(process.env.CHAT_BASE_PATH ?? "/chat").replace(/\/+$/, "")}/`;

export default defineConfig({
  base,
  plugins: [viteReact()],
  build: { outDir: "dist/client", emptyOutDir: true },
  resolve: { dedupe: ["react", "react-dom"] },
  server: {
    port: 4210,
    proxy: {
      [`${base}api`]: "http://127.0.0.1:4200",
      [`${base}open`]: "http://127.0.0.1:4200",
    },
  },
});
