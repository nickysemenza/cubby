import { describe, expect, it } from "vitest";
import { z } from "zod";

import { compileEntityDeclarations } from "../../../scripts/generator/entities/compile";

/**
 * Minimal valid two-field declaration ("subject", restated by a candidate
 * "tags" field) — everything `compileEntity` requires beyond `model`, held
 * fixed so each test only varies the `tags` field's `control.suggest`.
 */
const presentation = {
  titleField: "subject",
  domain: null,
  description: "Widgets.",
  emptyState: { title: "No widgets", description: "Add one." },
  icons: { phosphor: "Cube", sfSymbol: "cube", emoji: "🧊" },
} as const;

const base = {
  key: "widget",
  names: { singular: "Widget", plural: "Widgets" },
  route: null,
  table: null,
  identifiers: { brand: null, shortcode: null },
  presentation,
  fields: null,
  filters: { descriptors: [] },
  relations: [],
  search: { enabled: false },
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
    countFilter: null,
    relatednessSignals: null,
    mcpNames: null,
    ports: {
      repository: null,
      references: { label: null, resolver: null },
      filters: null,
      search: { projection: null, semanticText: null, dependentRefresh: null },
    },
  },
};

const subjectField = {
  key: "subject",
  kind: "text",
  validation: { read: z.string(), create: z.string(), update: z.string() },
} as const;

interface TagsFieldFixture {
  key: "tags";
  kind: "text" | "text-array";
  nullable?: boolean;
  control: {
    kind: "specialized";
    renderer: string;
    suggest: { basis: readonly string[]; mode: "prune" };
  };
  validation: { read: z.ZodTypeAny; create?: z.ZodTypeAny };
}

function declarationWithTags(tagsField: TagsFieldFixture) {
  return {
    ...base,
    model: {
      fields: [subjectField, tagsField],
      storage: ["subject", "tags"],
      create: ["subject", "tags"],
      update: ["subject", "tags"],
      output: ["subject", "tags"],
      bulk: [],
      audit: [],
    },
  };
}

describe('control.suggest.mode: "prune" compiles only onto a text-array target', () => {
  it("rejects a prune target that is not a text-array field", () => {
    expect(() =>
      compileEntityDeclarations([
        declarationWithTags({
          key: "tags",
          kind: "text",
          nullable: true,
          control: {
            kind: "specialized",
            renderer: "tag-list",
            suggest: { basis: ["subject"], mode: "prune" },
          },
          validation: { read: z.string().nullable() },
        }),
      ]),
    ).toThrow(/prune target must be a text-array field/);
  });

  it("accepts a prune target on a text-array field, judging its own entries", () => {
    const [compiled] = compileEntityDeclarations([
      declarationWithTags({
        key: "tags",
        kind: "text-array",
        control: {
          kind: "specialized",
          renderer: "tag-list",
          suggest: { basis: ["subject"], mode: "prune" },
        },
        validation: {
          read: z.array(z.string()),
          create: z.array(z.string()).default([]),
        },
      }),
    ]);
    const tags = compiled?.fieldModel.fields.find(
      (field) => field.key === "tags",
    );
    expect(tags?.control?.suggest).toEqual({
      basis: ["subject"],
      mode: "prune",
    });
  });

  it("still rejects a prune target naming itself explicitly in basis", () => {
    expect(() =>
      compileEntityDeclarations([
        declarationWithTags({
          key: "tags",
          kind: "text-array",
          control: {
            kind: "specialized",
            renderer: "tag-list",
            suggest: { basis: ["tags"], mode: "prune" },
          },
          validation: {
            read: z.array(z.string()),
            create: z.array(z.string()).default([]),
          },
        }),
      ]),
    ).toThrow(/cannot name its own field/);
  });
});
