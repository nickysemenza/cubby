import { generateShortcode } from "@cubby/shared";
import { describe, expect, it } from "vitest";

import { buildEntity, CREATABLE_ENTITIES, type CreatableEntity } from "./build";
import { deterministicToken, fakerFromSeed, hashSeed } from "./faker";
import { testFaker } from "./vitest-faker";

/**
 * Failure modes this layer guards (written before the implementation):
 * 1. A failing run cannot be replayed because filler drifts between runs, or
 *    two tests share one Faker sequence.
 * 2. A newly declared creatable entity has no usable defaults, so every caller
 *    hits an unreadable schema error (the table is typed exhaustive; this
 *    proves the defaults actually parse).
 * 3. An optional argument passed as `undefined` erases a default.
 * 4. A relation id is silently defaulted, attaching a test to a stranger.
 * 5. Filler names collide on a unique name index within one test.
 */

const code = <T extends Parameters<typeof generateShortcode>[0]>(type: T) =>
  generateShortcode(type);

/** Fields a factory refuses to invent: relations and external identifiers. */
function relationsFor(entity: CreatableEntity) {
  switch (entity) {
    case "inventory":
      return { productId: code("product"), locationId: code("location") };
    case "ledgerTransfer":
      return {
        fromPartyId: code("ledgerParty"),
        toPartyId: code("ledgerParty"),
      };
    case "purchase":
      return { vendorId: code("vendor") };
    case "financialTransaction":
      return { accountId: code("financialAccount") };
    case "planting":
      return { plantId: code("plant") };
    case "gardenEntry":
      return { locationId: code("location") };
    case "vendorAccount":
      return { vendorId: code("vendor"), ledgerPartyId: code("ledgerParty") };
    case "device":
      return { installationId: crypto.randomUUID() };
    default:
      return {};
  }
}

describe("entity factories", () => {
  it("builds every creatable entity from defaults plus only the caller's relations", () => {
    const faker = fakerFromSeed(hashSeed("every-entity"));
    for (const entity of CREATABLE_ENTITIES) {
      expect(
        () => buildEntity(entity, relationsFor(entity), { faker }),
        `${entity} defaults`,
      ).not.toThrow();
    }
  });

  it("never defaults a relation: omitting one fails with the schema's message", () => {
    expect(() => buildEntity("inventory", {})).toThrow(/factory inventory/u);
    expect(() => buildEntity("purchase", {})).toThrow(/vendorId/u);
  });

  it("replays from its seed and advances within a test", () => {
    const first = fakerFromSeed(hashSeed("test-a"));
    const again = fakerFromSeed(hashSeed("test-a"));
    const names = [1, 2, 3].map(
      () => buildEntity("product", {}, { faker: first }).name,
    );
    const replay = [1, 2, 3].map(
      () => buildEntity("product", {}, { faker: again }).name,
    );
    expect(replay).toEqual(names);
    expect(new Set(names).size).toBe(3);
    expect(
      buildEntity("product", {}, { faker: fakerFromSeed(hashSeed("test-b")) })
        .name,
    ).not.toBe(names[0]);
  });

  it("uses stable literal defaults without a Faker and keeps explicit values", () => {
    expect(buildEntity("product", {}).name).toBe("Test Product");
    expect(buildEntity("product", { name: undefined }).name).toBe(
      "Test Product",
    );
    expect(buildEntity("product", { name: "Chosen" }).name).toBe("Chosen");
  });

  it("derives record-name tokens from identity, not time", () => {
    expect(deterministicToken("proj", "a > b", 0)).toBe(
      deterministicToken("proj", "a > b", 0),
    );
    expect(deterministicToken("proj", "a > b", 0)).not.toBe(
      deterministicToken("proj", "a > b", 1),
    );
  });

  it("gives a Vitest test a faker seeded from its name", () => {
    expect(testFaker().string.alphanumeric(8)).toBe(
      testFaker().string.alphanumeric(8),
    );
  });
});
