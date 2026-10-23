import { dateRangeSchema } from "@cubby/schemas/date-range";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { compileEntityDeclarations } from "../generator/entities/compile";

const presentation = {
  titleField: "subject",
  domain: null,
  description: "Widgets.",
  emptyState: { title: "No widgets", description: "Add one." },
  icons: { phosphor: "Cube", sfSymbol: "cube", emoji: "🧊" },
} as const;

const text = (key: string) =>
  ({
    key,
    kind: "text",
    validation: { read: z.string(), create: z.string(), update: z.string() },
  }) as const;

const date = (key: string) => ({ key, kind: "date", nullable: true }) as const;
const range = (start: string, end: string) =>
  ({
    key: "window",
    kind: "dateRange",
    nullable: true,
    dateRange: { start, end, semantics: "period" },
    control: { kind: "dateRange" },
    display: {},
    validation: {
      read: dateRangeSchema.nullable(),
      create: dateRangeSchema.nullable().default(null),
      update: dateRangeSchema.nullable().optional(),
    },
  }) as const;

const declarationWithRange = (start: string, end: string) => ({
  key: "widget",
  names: { singular: "Widget", plural: "Widgets" },
  route: null,
  table: null,
  identifiers: { brand: null, shortcode: null },
  presentation,
  fields: null,
  filters: { descriptors: [] },
  relations: [],
  search: false as const,
  capabilities: {
    auditable: false,
    images: { storage: false as const },
    countable: false,
    softDelete: false,
    delete: null,
    merge: false,
    operationOwners: { delete: null, merge: null },
    mcp: [],
  },
  extensions: {
    relatednessSignals: null,
    ports: {
      repository: null,
      references: { label: null, resolver: null },
      filters: null,
      search: { projection: null, semanticText: null, dependentRefresh: null },
    },
  },
  model: {
    fields: [
      text("subject"),
      date("startsOn"),
      date("endsOn"),
      text("note"),
      range(start, end),
    ],
    storage: ["subject", "startsOn", "endsOn", "note"],
    create: ["subject", "window", "note"],
    update: ["subject", "window", "note"],
    output: ["subject", "window", "note"],
    audit: [],
  },
});

describe("compound date column ownership", () => {
  it("refuses non-date and duplicate endpoint columns before generating write contracts", () => {
    for (const [start, end] of [
      ["startsOn", "note"],
      ["startsOn", "startsOn"],
    ] as const) {
      expect(() =>
        compileEntityDeclarations([declarationWithRange(start, end)]),
      ).toThrow(/must be an unclaimed nullable stored date/);
    }
  });
});
