import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { cloudflare } from "@cloudflare/vite-plugin";
import { isFileLoadingAllowed, resolveConfig } from "vite";

// Config imports become denied runtime modules. Startup must still be able to
// load the shared Workflow policy without exposing deployment configuration.
test("Cloudflare config keeps the runtime Workflow policy loadable", async () => {
  const root = path.resolve(import.meta.dirname, "../..");
  const config = await resolveConfig(
    {
      root,
      configFile: false,
      plugins: [cloudflare({ types: { generate: false } })],
    },
    "serve",
  );
  for (const file of ["workflow-limits.ts", "workflow-platform-limits.json"]) {
    assert.equal(
      isFileLoadingAllowed(
        config,
        path.resolve(root, "../../packages/shared/src", file),
      ),
      true,
      `${file} must remain loadable by the Workflow runtime`,
    );
  }
  assert.equal(
    isFileLoadingAllowed(config, path.join(root, "cloudflare.config.ts")),
    false,
    "deployment configuration must remain denied",
  );
});
