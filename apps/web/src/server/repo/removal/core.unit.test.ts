import type { ActorContext } from "@cubby/schemas/context";
import type { AuditableEntity } from "@cubby/schemas/entity-manifest";
import { auditableEntities } from "@cubby/schemas/entity-manifest";
import type { SearchableEntity } from "@cubby/schemas/search";
import { testEntityId, testUserId } from "@cubby/schemas/testing";
import { describe, expect, expectTypeOf, it } from "vitest";

import type { DrizzleTransaction } from "~/server/db";
import type { AuditEntryInput } from "~/server/repo/audit-log";
import { SHORTCODE_TABLE } from "~/server/repo/shortcode-tables";

import { cascadeRemoval, type RemovableEntity } from "./core";

const ACTOR: ActorContext = { userId: testUserId("user-1"), source: "ui" };

const ids = <E extends RemovableEntity>(entity: E, ...v: string[]) =>
  v.map((seed) => testEntityId(entity, seed));

describe("cascadeRemoval — the type-level lock", () => {
  // oxlint-disable-next-line vitest/expect-expect -- This is a compile-time @ts-expect-error contract.
  it("refuses a hand-written delete entry", () => {
    // The mechanism this whole module exists for. Without the phantom witness
    // on `RemovalAuditEntry` this line compiles, and the invariant goes back to
    // being a convention a runtime detector catches after the fact.
    // @ts-expect-error a delete entry can only be minted by `cascadeRemoval`
    const forged: AuditEntryInput = {
      entityType: "product",
      entityId: "p1",
      action: "delete",
    };
    void forged;
  });

  // oxlint-disable-next-line vitest/expect-expect -- This is a compile-time @ts-expect-error contract.
  it("refuses ids branded for a different entity", () => {
    void ((tx: DrizzleTransaction) => {
      void cascadeRemoval(tx, {
        entity: "inventory",
        // @ts-expect-error product ids cannot be passed as an inventory removal
        ids: ids("product", "prd-1"),
        audit: { actor: ACTOR },
      });
    });
  });

  it("keeps every soft-deleted searchable entity removable", () => {
    // Image search documents are removed by IMAGE_HARD_DELETE. Every other
    // searchable entity must remain eligible for the audited cascade.
    expectTypeOf<
      Exclude<SearchableEntity, "image">
    >().toExtend<RemovableEntity>();
  });

  it("keeps RemovableEntity aligned with the shortcode table roster", () => {
    // `RemovableEntity` is `AuditableEntity & ShortcodeEntity`, and those two
    // sets used to coincide — every shortcoded entity was auditable, so the
    // intersection equalled the whole shortcode roster.
    //
    // `image` broke the coincidence: it was given `IMG-` so it stops being a
    // raw-uuid carve-out in every shape that can name an entity, but it stays
    // NON-auditable (it is the one hard delete, with no tombstone to annotate).
    // So it is in `SHORTCODE_TABLE` and out of `RemovableEntity` — which is the
    // correct outcome, because `removeEntity` must not be called for it;
    // `IMAGE_HARD_DELETE` owns that path. `importRun` is the other
    // exception: immutable history, neither auditable nor removable.
    expectTypeOf<RemovableEntity>().toExtend<keyof typeof SHORTCODE_TABLE>();
    expect([...auditableEntities].sort()).toEqual(
      Object.keys(SHORTCODE_TABLE)
        .filter((entity) => entity !== "image" && entity !== "importRun")
        .sort(),
    );
    expectTypeOf<RemovableEntity>().toExtend<AuditableEntity>();
  });
});
