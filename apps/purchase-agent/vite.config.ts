import { cloudflare } from "@cloudflare/vite-plugin";
import { flue, flueWorkerConfig } from "@flue/vite";
import { defineConfig } from "vite";

// Flue must generate this Worker entry before Cloudflare discovers bindings.
export default defineConfig({
  plugins: [flue(), cloudflare({ config: flueWorkerConfig() })],
});
