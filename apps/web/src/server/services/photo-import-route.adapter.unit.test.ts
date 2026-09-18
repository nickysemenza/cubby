import {
  coverEntities,
  imageIngressRouteById,
  logoEntities,
} from "@cubby/schemas/entity-manifest";
import { describe, expect, it } from "vitest";

import {
  isSingularImageOwner,
  photoImportRelationTraversals,
} from "~/server/repo/photo-import";

import {
  assertPhotoImportReplacementAllowed,
  assertPhotoImportSourceContext,
  materializePhotoImportCreateBody,
} from "./photo-import-route.adapter";

describe("manifest photo import routes", () => {
  it("materializes every binding kind over the staged editor body", () => {
    const body = materializePhotoImportCreateBody(
      {
        bindings: [
          { field: "ownerId", from: "source-id" },
          {
            field: "locationId",
            from: "source-field",
            sourceField: "locationId",
          },
          { field: "observedOn", from: "capture-date" },
          { field: "kind", from: "constant", value: "note" },
          {
            field: "recipes",
            from: "relation-items",
            item: { field: "recipeId", from: "source-id" },
          },
          {
            field: "locations",
            from: "relation-items",
            item: {
              field: "locationId",
              from: "source-field",
              sourceField: "locationId",
            },
          },
          {
            field: "flags",
            from: "relation-items",
            item: { field: "confirmed", from: "constant", value: true },
          },
        ],
      },
      { note: "kept", kind: "draft" },
      { entity: "recipe", id: "RCP-1" },
      "2026-09-16T23:30:00.000Z",
      new Map([["locationId", "LOC-2"]]),
    );

    expect(body).toEqual({
      note: "kept",
      ownerId: "RCP-1",
      locationId: "LOC-2",
      observedOn: "2026-09-16",
      kind: "note",
      recipes: [{ recipeId: "RCP-1" }],
      locations: [{ locationId: "LOC-2" }],
      flags: [{ confirmed: true }],
    });
  });

  it("rejects source records that do not belong to the selected route", () => {
    expect(() =>
      assertPhotoImportSourceContext(
        imageIngressRouteById["inventory-product"],
        { entity: "location", id: "LOC-1" },
      ),
    ).toThrow(/does not match route/);
  });

  it("preserves the staged calendar day at the binding boundary", () => {
    const body = materializePhotoImportCreateBody(
      { bindings: [{ field: "observedOn", from: "capture-date" }] },
      { observedOn: "2026-09-17" },
      { entity: "planting", id: "PLT-1" },
      "2026-09-16T23:30:00.000Z",
      new Map(),
    );

    expect(body.observedOn).toBe("2026-09-17");
  });

  it("does not overwrite an editable missing source binding with null", () => {
    const body = materializePhotoImportCreateBody(
      {
        bindings: [
          {
            field: "locationId",
            from: "source-field",
            sourceField: "locationId",
          },
        ],
      },
      { locationId: "LOC-EDIT" },
      { entity: "planting", id: "PLT-1" },
      null,
      new Map(),
    );

    expect(body.locationId).toBe("LOC-EDIT");

    const nullableSource = materializePhotoImportCreateBody(
      {
        bindings: [
          {
            field: "locationId",
            from: "source-field",
            sourceField: "locationId",
          },
        ],
      },
      { locationId: "LOC-EDIT" },
      { entity: "planting", id: "PLT-1" },
      null,
      new Map([["locationId", null]]),
    );
    expect(nullableSource.locationId).toBe("LOC-EDIT");
  });

  it("compiles the confirmed transaction-purchase route through allocations", () => {
    const route =
      imageIngressRouteById["financial-transaction-confirmed-purchase"];
    const traversals = photoImportRelationTraversals(
      route.sourceEntity,
      route.relationPath,
    );

    expect(traversals).toEqual([
      {
        targetEntity: "purchase",
        steps: [
          {
            edge: "FinancialTransactionAllocation.transactionId",
            direction: "incoming",
          },
          {
            edge: "FinancialTransactionAllocation.purchaseId",
            direction: "outgoing",
          },
        ],
      },
    ]);
  });

  it("requires replace confirmation only for an occupied singular owner", () => {
    const route = imageIngressRouteById["cookbook-cover"];
    expect(() =>
      assertPhotoImportReplacementAllowed(route, false, false),
    ).not.toThrow();
    expect(() =>
      assertPhotoImportReplacementAllowed(route, true, false),
    ).toThrow(/requires explicit replacement confirmation/);
    expect(() =>
      assertPhotoImportReplacementAllowed(route, true, true),
    ).not.toThrow();
  });

  it("has a typed adapter for every manifest singular image owner", () => {
    expect(
      [...coverEntities, ...logoEntities].every(isSingularImageOwner),
    ).toBe(true);
  });
});
