import { bindings, defineWorker, exports } from "cf/config";
import { expect, it } from "vitest";
import { resolveDevProfile } from "../../../../scripts/lib/dev-profile";
import { localWorker } from "./config";

// A preview retry must rebuild the current origin and keep local bindings isolated.
it("derives retry bindings from the selected ports without retaining production targets", () => {
  const production = defineWorker({
    name: "synthetic-api",
    compatibilityDate: "2026-09-19",
    domains: ["example.test"],
    env: {
      STORE: bindings.durableObject({
        worker: "synthetic-api",
        exportName: "Store",
      }),
      AI: bindings.ai({}),
      VECTORIZE: bindings.vectorize({ name: "synthetic-production-index" }),
      ACCESS_TOKEN: bindings.secret(),
    },
    exports: { Store: exports.durableObject({ storage: "sqlite" }) },
  });
  const profile = resolveDevProfile("/tmp/cubby-preview", { PORT: "3007" });
  const worker = localWorker(production, profile);
  const runtimeBindings = new Map(Object.entries(worker.env));
  expect(runtimeBindings.get("APP_ORIGIN")).toEqual(
    bindings.text("http://localhost:3007"),
  );
  expect(runtimeBindings.get("BETTER_AUTH_URL")).toEqual(
    bindings.text("http://localhost:3007"),
  );
  expect(worker.env.HYPERDRIVE.dev?.connectionString).toBe(profile.databaseUrl);
  expect(runtimeBindings.get("STORE")).toMatchObject({
    worker: worker.name,
    exportName: "Store",
  });
  expect(worker.domains).toEqual([]);
  expect(worker.env.AI).toBeUndefined();
  expect(worker.env.VECTORIZE).toBeUndefined();
  expect(runtimeBindings.get("ACCESS_TOKEN")).toBeUndefined();
});
