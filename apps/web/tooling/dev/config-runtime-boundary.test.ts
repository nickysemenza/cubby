import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { cloudflare } from "@cloudflare/vite-plugin";
import { isFileLoadingAllowed, resolveConfig } from "vite";

// Config imports become denied runtime modules. Startup must still be able to
// load the shared Job page limits without exposing deployment configuration.
test("Cloudflare config keeps the runtime Job page limits loadable", async () => {
  const root = path.resolve(import.meta.dirname, "../..");
  // Deny derivation is independent of the app's environment/persistence options.
  // Keep this real plugin boundary cheap instead of preparing a dev database.
  const config = await resolveConfig(
    {
      root,
      configFile: false,
      plugins: [cloudflare({ types: { generate: false } })],
    },
    "serve",
  );
  for (const denied of config.server.fs.deny) {
    for (const runtimeRoot of [
      path.join(root, "src"),
      path.resolve(root, "../../packages"),
    ]) {
      assert.equal(
        denied.startsWith(`${runtimeRoot}/`),
        false,
        `config must not deny runtime source: ${denied}`,
      );
    }
  }
  for (const file of [
    "job-page-limits.ts",
    "background-queue.ts",
    "background-queue-consumer.json",
  ]) {
    assert.equal(
      isFileLoadingAllowed(
        config,
        path.resolve(root, "../../packages/shared/src", file),
      ),
      true,
      `${file} must remain loadable by the Job runtime`,
    );
  }
  assert.equal(
    isFileLoadingAllowed(config, path.join(root, "cloudflare.config.ts")),
    false,
    "deployment configuration must remain denied",
  );
});
