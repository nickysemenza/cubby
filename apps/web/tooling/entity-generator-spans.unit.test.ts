import { describe, expect, it } from "vitest";
import { z } from "zod";

import { compileEntityDeclarations } from "../../../scripts/generator/entities/compile";

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

const date = (key: string) =>
  ({
    key,
    kind: "date",
    nullable: true,
    control: { kind: "date" },
    display: { list: true, detail: true, format: "plainDate" },
    validation: {
      read: z.string().nullable(),
      create: z.string().nullable().default(null),
      update: z.string().nullable().optional(),
    },
  }) as const;

const declarationWithSpans = (
  spans: readonly { start: string; end: string; label: string }[],
) => ({
  key: "widget",
  names: { singular: "Widget", plural: "Widgets" },
  route: null,
  table: null,
  identifiers: { brand: null, shortcode: null },
  presentation: { ...presentation, spans },
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
    bulkUpdate: null,
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
    fields: [text("subject"), date("startsOn"), date("endsOn"), text("note")],
    storage: ["subject", "startsOn", "endsOn", "note"],
    create: ["subject", "startsOn", "endsOn", "note"],
    update: ["subject", "startsOn", "endsOn", "note"],
    output: ["subject", "startsOn", "endsOn", "note"],
    bulk: [],
    audit: [],
  },
});

describe("presentation.spans", () => {
  it("compiles a start/end date pair onto the presentation", () => {
    const [compiled] = compileEntityDeclarations([
      declarationWithSpans([
        { start: "startsOn", end: "endsOn", label: "Window" },
      ]),
    ]);
    expect(compiled?.inspector.spans).toEqual([
      { start: "startsOn", end: "endsOn", label: "Window" },
    ]);
  });

  it("rejects a span that names a non-date field", () => {
    expect(() =>
      compileEntityDeclarations([
        declarationWithSpans([
          { start: "startsOn", end: "note", label: "Window" },
        ]),
      ]),
    ).toThrow(/spans\[0\] names note, which is not a date field/);
  });

  it("rejects a field claimed by two spans", () => {
    expect(() =>
      compileEntityDeclarations([
        declarationWithSpans([
          { start: "startsOn", end: "endsOn", label: "Window" },
          { start: "endsOn", end: "startsOn", label: "Again" },
        ]),
      ]),
    ).toThrow(/already claims/);
  });
});
