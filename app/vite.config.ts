import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import { reactApp } from "@krynodes/vite-config";

export default reactApp({
  plugins: [tailwindcss()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
});
