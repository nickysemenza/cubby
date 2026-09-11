import { Validator } from "@cfworker/json-schema";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { httpContract } from "~/lib/generated/http-contract.gen";
import document from "~/lib/generated/http-openapi.gen.json";
import { START_OPERATIONS } from "~/lib/generated/start-operation-registry.gen";

import { httpSchemaSources } from "./contract";

const operations = Object.entries(httpContract).flatMap(([resource, entries]) =>
  Object.entries(entries).map(([operation, contract]) => ({
    id: `${resource}.${operation}`,
    contract,
  })),
);

describe("generated HTTP contract", () => {
  it("exposes and documents every ordinary operation exactly once", () => {
    const expected = Object.entries(START_OPERATIONS)
      .filter(([, value]) => value.kind !== "subscription")
      .map(([id]) => id)
      .sort();
    expect(operations.map(({ id }) => id).sort()).toEqual(expected);
    expect(Object.keys(document.paths).sort()).toEqual(
      operations.map(({ contract }) => contract.path).sort(),
    );
    expect(document.security).toEqual([{ apiKey: [] }]);
  });

  it("preserves concrete input validation and output date schemas", () => {
    const input = httpSchemaSources.get(
      httpContract.entity.detail.body,
    )!.schema;
    expect(
      input.safeParse({ input: { entity: "vendor", shortcode: "not-a-code" } })
        .success,
    ).toBe(false);
    expect(
      input.safeParse({ input: { entity: "vendor", shortcode: "VEN-ABCD" } })
        .success,
    ).toBe(true);
    const output = httpSchemaSources.get(
      httpContract.auditLog.list.responses[200],
    )!.schema;
    expect(output).toBeInstanceOf(z.ZodType);
    expect(JSON.stringify(document)).toContain('"format":"date-time"');
  });

  it("accepts ISO input timestamps consistently with the documented JSON shape", () => {
    const schema = httpSchemaSources.get(
      httpContract.inventory.reconcileSession.body,
    )!.schema;
    const input = {
      input: {
        locationId: "LOC-HM3E",
        expectedInventoryEntryIds: [],
        snapshotUpdatedAt: "2026-09-10T00:00:00.000Z",
        resolutions: [],
      },
    };
    const validator = new Validator({
      $ref: "#/components/schemas/input_inventory.reconcileSession_body",
      components: document.components,
    });
    expect(validator.validate(input).valid).toBe(true);
    expect(schema.safeParse(input).success).toBe(true);
    const invalid = { input: { ...input.input, snapshotUpdatedAt: "invalid" } };
    expect(validator.validate(invalid).valid).toBe(false);
    expect(schema.safeParse(invalid).success).toBe(false);
  });

  it("contains only resolvable local references and no Zod-only metadata", () => {
    const serialized = JSON.stringify(document);
    const references = [
      ...serialized.matchAll(/"\$ref":"#\/components\/schemas\/([^"]+)"/gu),
    ].map((match) => match[1]!);
    const names = new Set(Object.keys(document.components.schemas));
    expect(references.length).toBeGreaterThan(0);
    expect(references.filter((name) => !names.has(name))).toEqual([]);
    expect(serialized).not.toMatch(/"(?:mock|mockValue|\$id)":/u);
  });
});
