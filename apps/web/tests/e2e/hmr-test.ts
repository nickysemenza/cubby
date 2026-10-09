import { randomUUID } from "node:crypto";
import { test as base, expect, request } from "@playwright/test";

import type {
  CreatableEntity,
  EntityOverrides,
} from "../../tooling/factories/build";
import { fakerFromSeed, hashSeed } from "../../tooling/factories/faker";

import {
  assertHmrRuntimeIdentity,
  discoverHmrSession,
  type HmrSession,
} from "./hmr-session";

type OwnedRecords = {
  /** A name no other run or household record can share. */
  name: (label: string) => string;
  create: <E extends CreatableEntity>(
    entity: E,
    overrides?: EntityOverrides<E>,
  ) => Promise<{ id: string }>;
  /** Delete every record this test created; teardown repeats it idempotently. */
  cleanup: () => Promise<void>;
};

/**
 * The optional lane against the persistent `pnpm dev` origin. Identity and
 * readiness are proved once per worker before the first write, every record a
 * test writes is named with a run-unique token and deleted through the entity
 * kernel afterward, and nothing here touches records it did not create.
 */
export const test = base.extend<
  { owned: OwnedRecords },
  { hmrSession: HmrSession }
>({
  hmrSession: [
    // Playwright requires a destructured fixture dependency list; this worker has none.
    // eslint-disable-next-line no-empty-pattern
    async ({}, provide) => {
      const session = discoverHmrSession();
      Object.assign(process.env, session.profile.vars, {
        E2E_DATABASE_URL: session.profile.databaseUrl,
      });
      await assertHmrRuntimeIdentity(session);
      await provide(session);
    },
    { scope: "worker", auto: true },
  ],
  baseURL: async ({ hmrSession }, provide) => {
    await provide(hmrSession.session.origin);
  },
  storageState: async ({ hmrSession }, provide) => {
    const context = await request.newContext({
      baseURL: hmrSession.session.origin,
    });
    try {
      const login = await context.get("/__dev/login?next=/", {
        maxRedirects: 0,
      });
      expect(login.status(), await login.text()).toBe(303);
      await provide(await context.storageState());
    } finally {
      await context.dispose();
    }
  },
  owned: async ({ page, hmrSession }, provide, testInfo) => {
    await assertHmrRuntimeIdentity(hmrSession);
    // Server modules capture environment at import time; load only after the
    // session worker fixture binds this checkout's verified profile.
    const [{ executeEntity }, { createEntity }, { fixtureKernelContext }] =
      await Promise.all([
        import("~/server/entity-kernel"),
        import("../../tooling/factories/create"),
        import("./fixtures-core"),
      ]);
    const run = randomUUID().slice(0, 8);
    const faker = fakerFromSeed(hashSeed(...testInfo.titlePath, run));
    const created: Array<{ entity: CreatableEntity; id: string }> = [];
    const kernel = () => fixtureKernelContext(page);
    const owned: OwnedRecords = {
      name: (label) => `HMR ${label} ${run}`,
      create: async (entity, overrides) => {
        const record = await createEntity(await kernel(), entity, overrides, {
          faker,
        });
        created.push({ entity, id: record.id });
        return record;
      },
      cleanup: async () => {
        const context = await kernel();
        // Attempt every deletion; a failed record stays owned for the next call.
        const failures: unknown[] = [];
        for (const record of [...created].reverse()) {
          try {
            await executeEntity(context, {
              action: "delete",
              entity: record.entity,
              ids: [record.id],
            });
            created.splice(created.indexOf(record), 1);
          } catch (error) {
            failures.push(error);
          }
        }
        if (failures.length > 0)
          throw new AggregateError(
            failures,
            `HMR cleanup left ${created.length} owned record(s): ${created.map((record) => record.id).join(", ")}`,
          );
      },
    };
    try {
      await provide(owned);
    } finally {
      await owned.cleanup();
    }
  },
});

export { expect };
