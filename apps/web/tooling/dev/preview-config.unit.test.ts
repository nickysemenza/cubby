import { expect, it } from "vitest";
import { previewConfig } from "./preview-config";
import { resolveDevProfile } from "../../../../scripts/lib/dev-profile";

// Wrangler reads vars from JSON; process env cannot repair a stale build origin.
it("refreshes built Worker bindings for the selected retry ports", () => {
  const original = resolveDevProfile("/tmp/cubby-preview", {});
  const retry = resolveDevProfile("/tmp/cubby-preview", { PORT: "3007" });
  const built = {
    main: "worker.js",
    assets: { directory: "../client" },
    vars: original.vars,
    hyperdrive: [
      { binding: "HYPERDRIVE", localConnectionString: original.databaseUrl },
    ],
  };
  const config = previewConfig(built, "/tmp/cubby-preview/dist/server", retry);
  expect(config.main).toBe("/tmp/cubby-preview/dist/server/worker.js");
  expect(config.assets.directory).toBe("/tmp/cubby-preview/dist/client");
  expect(config.vars).toMatchObject({
    APP_ORIGIN: "http://localhost:3007",
    BETTER_AUTH_URL: "http://localhost:3007",
    CUBBY_DEV_ID: retry.id,
    DATABASE_URL: retry.databaseUrl,
  });
});
