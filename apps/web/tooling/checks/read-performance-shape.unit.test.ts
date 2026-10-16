import { expect, it } from "vitest";
import {
  requestedReadMetadata,
  workloadContextSchema,
} from "./read-performance-shape";

// Failure modes: arbitrary keys/values leak through metadata; a report is mistaken
// for loaded dependencies; unsupported requests look complete; context accepts prose.
it("admits only declared shape and preserves unknown evidence", () => {
  const metadata = requestedReadMetadata("entityReport.getMany", {
    slots: ["project.budget", "project.budget"],
    id: "synthetic-private-id",
    filters: { "synthetic-secret-key": "synthetic-secret-value" },
  });
  expect(metadata).toMatchObject({
    kind: "report",
    slots: ["project.budget", "project.budget"],
    loadedDependencies: null,
  });
  expect(JSON.stringify(metadata)).not.toContain("synthetic-");
  expect(
    requestedReadMetadata("entityReport.getMany", {
      slots: ["synthetic-secret"],
    }),
  ).toBeNull();
  expect(requestedReadMetadata("entityReport.get", undefined)).toBeNull();
  expect(
    requestedReadMetadata("other.query", { slots: ["project.budget"] }),
  ).toBeNull();
});
it("describes list projections from declarations, not supplied field names", () => {
  const metadata = requestedReadMetadata("entity.listEnrichment", {
    entity: "product",
    groups: ["derived"],
    ids: ["synthetic-private-id"],
    fields: ["synthetic-secret"],
  });
  expect(metadata).toMatchObject({
    kind: "list",
    projection: "enrichment",
    groups: ["derived"],
    loadedDependencies: null,
  });
  expect(JSON.stringify(metadata)).not.toContain("synthetic-");
  expect(metadata).toMatchObject({ declaredFields: expect.any(Array) });
  expect(
    requestedReadMetadata("entity.listSummary", { entity: "product" }),
  ).toMatchObject({ declaredFields: null });
  expect(
    requestedReadMetadata("entity.listEnrichment", {
      entity: "product",
      groups: ["synthetic-secret"],
    }),
  ).toBeNull();
});
it("bounds operator context without free text or raw workload records", () => {
  expect(
    workloadContextSchema.parse({
      environment: "local",
      population: "synthetic",
      scale: 1000,
      cache: "warm",
      revision: "a".repeat(40),
    }),
  ).toMatchObject({ scale: 1000 });
  expect(
    workloadContextSchema.safeParse({ environment: "synthetic-secret" })
      .success,
  ).toBe(false);
  expect(
    workloadContextSchema.safeParse({ records: ["synthetic-private-id"] })
      .success,
  ).toBe(false);
});

it("publishes only schema-admitted list filter names", () => {
  const metadata = requestedReadMetadata("entity.listBase", {
    entity: "product",
    filters: {
      searchQuery: "synthetic-private-value",
      "synthetic-secret-key": "synthetic-private-value",
    },
  });
  expect(metadata).toMatchObject({
    filterFields: ["searchQuery"],
    declaredGroupDependencies: null,
  });
  expect(JSON.stringify(metadata)).not.toContain("synthetic-");
});
