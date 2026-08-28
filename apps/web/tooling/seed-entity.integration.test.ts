import {
  entityManifest,
  shortcodeEntities,
} from "@cubby/schemas/entity-manifest";
import { describe, expect, it } from "vitest";
import { ENTITY_BINDINGS } from "~/server/entity-bindings";
import { ENTITY_KERNEL_ENTITIES } from "~/server/entity-kernel/contracts";
import { seedEntity, withTestDb } from "./test-setup";

/**
 * `seedEntity` (test-setup.ts) exists so an integration test can seed ANY
 * entity through the generic kernel without a hand-written
 * `make<Entity>Input()` builder that can drift from what create actually
 * accepts (see the file header there). This is the completeness guard: every
 * entity the manifest says is creatable — and every entity the kernel
 * exposes as CRUD — must actually be seedable, or `seedEntity`
 * silently narrows to a subset of the entities callers assume it covers.
 */
describe("seedEntity completeness", () => {
  const ctx = withTestDb();
  const kernelEntities = new Set<string>(ENTITY_KERNEL_ENTITIES);

  it("seeds one row of every entity with a declared MCP create / kernel create binding", async () => {
    const declaresCreate = (entity: (typeof shortcodeEntities)[number]) =>
      entityManifest[entity].mcp.some((action) => action === "create");
    const hasKernelCreate = (entity: (typeof shortcodeEntities)[number]) =>
      kernelEntities.has(entity) && ENTITY_BINDINGS[entity].crud !== null;

    const candidates = ENTITY_KERNEL_ENTITIES.filter((entity) =>
      hasKernelCreate(entity),
    );
    expect(candidates.length).toBeGreaterThanOrEqual(14);

    // The two signals must agree for every candidate — a manifest entity with
    // no kernel binding (or vice versa) is exactly the drift `seedEntity`'s
    // own "not kernel-creatable" error exists to catch, and this asserts
    // it can never happen silently.
    for (const entity of shortcodeEntities) {
      expect(
        declaresCreate(entity),
        `${entity}: manifest and kernel disagree on whether create exists`,
      ).toBe(hasKernelCreate(entity));
    }

    // Independent prerequisites, seeded first so the few entities with a
    // required cross-entity foreign key have a real id to point at.
    const vendor = await seedEntity(ctx.db, "vendor");
    // `kind` is pinned to non-"household" values: createLedgerParty enforces a
    // singleton household party, so letting mock() roll the enum makes the
    // second create (or a template-seeded household) fail intermittently.
    const partyA = await seedEntity(ctx.db, "ledgerParty", {
      kind: "member",
    });
    const partyB = await seedEntity(ctx.db, "ledgerParty", {
      kind: "guest",
    });
    const account = await seedEntity(ctx.db, "financialAccount");
    const product = await seedEntity(ctx.db, "product");
    const location = await seedEntity(ctx.db, "location");

    const prereqs = new Set([
      "vendor",
      "ledgerParty",
      "financialAccount",
      "product",
      "location",
    ]);

    // Every OTHER candidate's create input is self-sufficient under mock()'s
    // own policy (nullable/defaulted FKs generate `null`) except these four,
    // whose required fields `mock()` cannot discover a real id or a
    // refine-safe value for on its own:
    //   - purchase.vendorId / inventory.{productId,locationId} /
    //     ledgerTransfer.{fromPartyId,toPartyId}: required shortcodes that
    //     must resolve to a LIVE row.
    //   - financialTransaction: `kind`/`status`/`postedDate` are checked by
    //     two cross-field refines (`validSettlementState`,
    //     `postedRequiresDate`) — "other"/"pending" satisfies both
    //     regardless of the (nullable) postedDate mock() generates, where a
    //     random `kind` like "refund" would intermittently fail
    //     `validSettlementState`'s sign check.
    for (const entity of candidates) {
      if (prereqs.has(entity)) continue;
      const result =
        entity === "purchase"
          ? await seedEntity(ctx.db, entity, { vendorId: vendor.id })
          : entity === "inventory"
            ? await seedEntity(ctx.db, entity, {
                productId: product.id,
                locationId: location.id,
              })
            : entity === "ledgerTransfer"
              ? await seedEntity(ctx.db, entity, {
                  fromPartyId: partyA.id,
                  toPartyId: partyB.id,
                })
              : entity === "financialTransaction"
                ? await seedEntity(ctx.db, entity, {
                    accountId: account.id,
                    kind: "other",
                    status: "pending",
                  })
                : await seedEntity(ctx.db, entity);
      expect(result, `seedEntity(${entity}) returned nothing`).toBeTruthy();
    }
  });
});
