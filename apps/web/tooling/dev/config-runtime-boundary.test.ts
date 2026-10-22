import assert from "node:assert/strict";
import path from "node:path";
import { readFileSync } from "node:fs";
import { productionWorker } from "../../cloudflare.config.ts";
import { test } from "node:test";
import { cloudflare } from "@cloudflare/vite-plugin";
import { isFileLoadingAllowed, resolveConfig } from "vite";

// Config imports become denied runtime modules. Startup must still be able to
// load the shared Job page limits and Worker identity without exposing
// deployment configuration.
test("Cloudflare config keeps the runtime Job limits and identity loadable", async () => {
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
  for (const file of [
    "worker-identity.json",
    "src/server/worker-identity.ts",
  ]) {
    assert.equal(
      isFileLoadingAllowed(config, path.join(root, file)),
      true,
      `${file} must remain loadable by the Worker runtime`,
    );
  }
  assert.equal(
    isFileLoadingAllowed(config, path.join(root, "cloudflare.config.ts")),
    false,
    "deployment configuration must remain denied",
  );
});

// Inspect the thin entry's static named re-exports without executing its server
// graph in Node or pulling implementations into the ambient Env compiler graph.
test("configured live Durable Objects match the actual Worker re-exports", () => {
  const root = path.resolve(import.meta.dirname, "../..");
  const source = readFileSync(path.join(root, "src/cf-server.ts"), "utf8");
  const actual = [
    ...source.matchAll(/export\s*\{([^}]+)\}\s*from\s*["'][^"']+["']/gu),
  ]
    .flatMap((match) => (match[1] ?? "").split(","))
    .map((name) => name.trim())
    .filter(Boolean);
  const live = Object.entries(productionWorker.exports)
    .filter(
      ([, declaration]) =>
        !["deleted", "renamed", "transferred"].includes(
          declaration.state ?? "",
        ),
    )
    .map(([name]) => name);
  assert.deepEqual(actual.sort(), live.sort());
});
