import {
  entityManifest,
  shortcodeEntities,
} from "@cubby/schemas/entity-manifest";
import { describe, expect, it } from "vitest";
import { appRouter } from "~/server/api/root";
import { createTestCaller } from "~/server/api/trpc";
import { seedEntity, withTestDb } from "./test-setup";

/**
 * `seedEntity` (test-setup.ts) exists so an integration test can seed ANY
 * entity through its real create procedure without a hand-written
 * `make<Entity>Input()` builder that can drift from what create actually
 * accepts (see the file header there). This is the completeness guard: every
 * entity the manifest says is creatable — and every entity the live router
 * agrees has a create procedure — must actually be seedable, or `seedEntity`
 * silently narrows to a subset of the entities callers assume it covers.
 */
describe("seedEntity completeness", () => {
  const ctx = withTestDb();

  it("seeds one row of every entity with a declared MCP create / live create procedure", async () => {
    const caller = createTestCaller(appRouter, ctx.db);
    const procedures = (
      appRouter as unknown as {
        _def: { procedures: Record<string, unknown> };
      }
    )._def.procedures;

    const declaresCreate = (entity: (typeof shortcodeEntities)[number]) =>
      (entityManifest[entity].mcp as readonly string[]).includes("create");
    const hasProcedure = (entity: (typeof shortcodeEntities)[number]) =>
      Boolean(procedures[`${entity}.create`]);

    const candidates = shortcodeEntities.filter(
      (entity) => declaresCreate(entity) || hasProcedure(entity),
    );
    expect(candidates.length).toBeGreaterThanOrEqual(14);

    // The two signals must agree for every candidate — a manifest entity with
    // no router procedure (or vice versa) is exactly the drift `seedEntity`'s
    // own "not a declared procedure" error exists to catch, and this asserts
    // it can never happen silently.
    for (const entity of candidates) {
      expect(
        {
          entity,
          declares: declaresCreate(entity),
          live: hasProcedure(entity),
        },
        `${entity}: manifest and router disagree on whether create exists`,
      ).toEqual({ entity, declares: true, live: true });
    }

    // Independent prerequisites, seeded first so the few entities with a
    // required cross-entity foreign key have a real id to point at.
    const vendor = (await seedEntity(caller, "vendor")) as { id: string };
    const partyA = (await seedEntity(caller, "ledgerParty")) as { id: string };
    const partyB = (await seedEntity(caller, "ledgerParty")) as { id: string };
    const account = (await seedEntity(caller, "financialAccount")) as {
      id: string;
    };
    const product = (await seedEntity(caller, "product")) as { id: string };
    const location = (await seedEntity(caller, "location")) as { id: string };

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
    const overridesByEntity: Partial<Record<string, Record<string, unknown>>> =
      {
        purchase: { vendorId: vendor.id },
        inventory: { productId: product.id, locationId: location.id },
        ledgerTransfer: { fromPartyId: partyA.id, toPartyId: partyB.id },
        financialTransaction: {
          accountId: account.id,
          kind: "other",
          status: "pending",
        },
      };

    for (const entity of candidates) {
      if (prereqs.has(entity)) continue;
      const result = await seedEntity(
        caller,
        entity,
        overridesByEntity[entity],
      );
      expect(result, `seedEntity(${entity}) returned nothing`).toBeTruthy();
    }
  });
});
