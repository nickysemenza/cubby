import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveDevProfile } from "./lib/dev-profile.ts";

// Failure modes: inherited production targets, cross-checkout state collisions,
// an explicit wrong local database, and live resources leaking into offline dev.
test("checkouts have stable, independent database and storage identities", () => {
  const first = resolveDevProfile("/tmp/cubby-one", {});
  assert.equal(first.id, resolveDevProfile("/tmp/cubby-one", {}).id);
  const second = resolveDevProfile("/tmp/cubby-two", {});
  assert.notEqual(first.name, second.name);
  assert.notEqual(first.stateDir, second.stateDir);
  assert.equal(first.vars.E2E_AUTH_TEST_MODE, "false");
});

test("disposable dev validation instances do not share the interactive session", () => {
  const regular = resolveDevProfile("/tmp/cubby", {});
  const validation = resolveDevProfile("/tmp/cubby", {
    CUBBY_DEV_INSTANCE: "e2e_123",
  });
  assert.notEqual(validation.name, regular.name);
  assert.notEqual(validation.stateDir, regular.stateDir);
  assert.throws(() =>
    resolveDevProfile("/tmp/cubby", { CUBBY_DEV_INSTANCE: "../other" }),
  );
});

test("refuses inherited remote database and object storage targets", () => {
  for (const env of [
    { DATABASE_URL: "postgresql://user:secret@db.example.com/cubby" },
    { R2_ENDPOINT: "https://example.r2.cloudflarestorage.com" },
    {
      WRANGLER_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE:
        "postgresql://user:secret@db.example.com/cubby",
    },
    {
      CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE_CACHED:
        "postgresql://user:secret@db.example.com/cubby",
    },
  ])
    assert.throws(() => resolveDevProfile("/tmp/cubby", env), /Refusing/u);
});

test("explicit database selection stays local and rejects a conflicting override", () => {
  const profile = resolveDevProfile("/tmp/cubby", {
    CUBBY_DEV_DB_NAME: "cubby_dev_feature",
  });
  assert.equal(profile.name, "cubby_dev_feature");
  assert.throws(() =>
    resolveDevProfile("/tmp/cubby", { CUBBY_DEV_DB_NAME: "production" }),
  );
  assert.throws(
    () =>
      resolveDevProfile("/tmp/cubby", {
        DATABASE_URL:
          "postgresql://postgres:password@localhost:55432/cubby_dev_other",
      }),
    /Refusing/u,
  );
});

test("integrations require a checkout-isolated vector index", () => {
  assert.throws(
    () =>
      resolveDevProfile("/tmp/cubby", { CUBBY_DEV_PROFILE: "integrations" }),
    /integrations/u,
  );
  const offline = resolveDevProfile("/tmp/cubby", {});
  assert.throws(
    () =>
      resolveDevProfile("/tmp/cubby", {
        CUBBY_DEV_PROFILE: "integrations",
        CUBBY_DEV_VECTORIZE_INDEX: "cubby-openai-text-embedding-3-small-1536",
      }),
    /integrations/u,
  );
  const live = resolveDevProfile("/tmp/cubby", {
    CUBBY_DEV_PROFILE: "integrations",
    CUBBY_DEV_VECTORIZE_INDEX: `cubby-dev-${offline.id}`,
    CUBBY_DEV_AI_GATEWAY_API_KEY: "synthetic-key",
  });
  assert.equal(live.profile, "integrations");
  assert.equal(live.integration?.vectorizeIndex, `cubby-dev-${offline.id}`);
  assert.equal(live.vars.AI_GATEWAY_API_KEY, "synthetic-key");
});

// Billed AI traffic shares the `cubby` gateway, labelled `development` at
// runtime; offline dev stays unable to bill because it carries no key.
test("dev profiles never redirect the gateway, and offline dev carries no key", () => {
  const offline = resolveDevProfile("/tmp/cubby", {
    CUBBY_DEV_AI_GATEWAY_API_KEY: "synthetic-key",
  });
  assert.equal(offline.vars.AI_GATEWAY_API_KEY, "");
  assert.equal("AI_GATEWAY_ID" in offline.vars, false);
});
