import type { EntityFieldProvenance } from "@cubby/schemas/entity-fields";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  entityFieldProvenance,
  FieldProvenance,
  formatFieldProvenance,
  isInspectableFieldProvenance,
  labeledFieldProvenance,
  relationshipFieldProvenance,
} from "./field-provenance";

const reference = (
  overrides: Partial<EntityFieldProvenance> = {},
): EntityFieldProvenance => ({
  kind: "reference",
  sources: [{ entity: "product", label: null, relation: "productId" }],
  ...overrides,
});

describe("formatFieldProvenance", () => {
  const cases: readonly (readonly [EntityFieldProvenance, string])[] = [
    [reference(), "Linked to Product"],
    [
      {
        kind: "relation",
        sources: [
          { entity: "vendor", label: "Supplier", relation: "vendor" },
          { entity: "project", label: null, relation: "project" },
        ],
      },
      "Managed through Supplier + Projects",
    ],
    [
      {
        kind: "derived",
        sources: [{ entity: null, label: "Expense total", relation: null }],
      },
      "From Expense total",
    ],
  ];

  it.each(cases)("formats %s", (provenance, expected) => {
    expect(formatFieldProvenance(provenance)).toBe(expected);
  });
});

describe("specialist provenance builders", () => {
  it("resolves relation-backed sources from the entity manifest", () => {
    expect(relationshipFieldProvenance("purchase", "expenses")).toEqual({
      kind: "derived",
      sources: [{ entity: "expense", label: null, relation: "expenses" }],
    });
  });

  it("keeps truthful non-entity source labels non-inspectable", () => {
    expect(labeledFieldProvenance("Product identifiers")).toEqual({
      kind: "derived",
      sources: [{ entity: null, label: "Product identifiers", relation: null }],
    });
  });

  it("keeps external entity sources non-inspectable without a local relation", () => {
    expect(entityFieldProvenance("usda-food")).toEqual({
      kind: "derived",
      sources: [{ entity: "usda-food", label: null, relation: null }],
    });
  });
});

describe("isInspectableFieldProvenance", () => {
  it("keeps direct references on their existing links and pickers", () => {
    expect(isInspectableFieldProvenance(reference())).toBe(false);
  });

  it("allows relation-backed projections to open their source records", () => {
    expect(
      isInspectableFieldProvenance({
        ...reference(),
        kind: "derived",
      }),
    ).toBe(true);
  });
});

describe("FieldProvenance", () => {
  it("shows the full phrase accessibly and reinforces entity sources with icons", () => {
    const phrase = "Managed through Supplier + Projects";
    render(
      <FieldProvenance
        provenance={{
          kind: "relation",
          sources: [
            { entity: "vendor", label: "Supplier", relation: "vendor" },
            { entity: "project", label: null, relation: "project" },
          ],
        }}
      />,
    );

    const source = screen.getByRole("note", { name: phrase });
    expect(source).toHaveAttribute("title", phrase);
    expect(source).toHaveTextContent(phrase);
    expect(source.querySelectorAll("svg")).toHaveLength(2);
  });
});
