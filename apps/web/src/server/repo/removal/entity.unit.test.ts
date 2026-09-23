import { type ActorContext, buildActorContext } from "@cubby/schemas/context";
import { testEntityId, testUserId } from "@cubby/schemas/testing";
import { describe, it } from "vitest";

import type { DrizzleTransaction } from "~/server/db";
import { taskDependency } from "~/server/db/schema";
// `ChildCascade` deliberately comes through the barrel: these assertions lock
// the interface callers use, not this module's private implementation.
import type { ChildCascade } from "~/server/repo/removal";

import type { RemovableEntity } from "./core";
import { removeEntity } from "./entity";

const ACTOR: ActorContext = buildActorContext(testUserId("user-1"));

const ids = <E extends RemovableEntity>(entity: E, ...seeds: string[]) =>
  seeds.map((seed) => testEntityId(entity, seed));

describe("removeEntity — type-level interface locks", () => {
  // oxlint-disable-next-line vitest/expect-expect -- Compile-time @ts-expect-error contract.
  it("refuses an auditKey on a hard-delete child", () => {
    // @ts-expect-error a hard-delete child cannot be counted, so it has no audit key
    const child: ChildCascade = {
      table: taskDependency,
      parentColumns: [taskDependency.taskId],
      mode: "hard",
      auditKey: "cascadedDependencies",
    };
    void child;
  });

  // oxlint-disable-next-line vitest/expect-expect -- Compile-time @ts-expect-error contract.
  it("refuses a soft-delete child whose table has no deletedAt", () => {
    // @ts-expect-error TaskDependency has no deletedAt, so it cannot be soft-deleted
    const child: ChildCascade = {
      table: taskDependency,
      parentColumns: [taskDependency.taskId],
    };
    void child;
  });

  // oxlint-disable-next-line vitest/expect-expect -- Compile-time @ts-expect-error contract.
  it("refuses ids branded for a different entity", () => {
    void ((tx: DrizzleTransaction) => {
      void removeEntity(tx, {
        entity: "product",
        // @ts-expect-error task ids cannot be passed as a product removal
        ids: ids("task", "t1"),
        removal: "soft",
        actor: ACTOR,
      });
    });
  });
});
