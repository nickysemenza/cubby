import { bindings, defineConfig } from "cf/config";

// Nx remote cache for CI and the developer's Mac; see
// docs/adr/0009-content-hash-merge-gate.md.
export default defineConfig({
  worker: {
    name: "cubby-nx-cache",
    entrypoint: "src/index.ts",
    compatibilityDate: "2026-09-19",
    workersDev: true,
    assets: { runWorkerFirst: true },
    env: {
      ASSETS: bindings.assets(),
      EVENTS: bindings.analyticsEngineDataset({ name: "cubby_nx_cache" }),
      ANALYTICS_SQL: bindings.analytics(),
      CACHE: bindings.r2({ name: "cubby-nx-cache" }),
      CACHE_TOKEN: bindings.secret(),
    },
  },
});
