import { fromPartial } from "@total-typescript/shoehorn";
import { describe, expect, it } from "vitest";

import { validateDataQualityDeclarations } from "../generator/entities/data-quality";
import type { CompiledEntity } from "../generator/entities/declarations";

// The cross-entity pass reads only key, dataQuality and descriptors.
const scored = (key: string, related: string[]): CompiledEntity =>
  fromPartial<CompiledEntity>({
    key,
    filterDescriptors: [],
    dataQuality: {
      checks: [
        {
          id: `${key}_check`,
          facet: "identity",
          kind: "missing",
          weight: 1,
          scoring: "weighted",
          exceptions: "inherit",
          label: "Check",
          message: "Synthetic.",
        },
      ],
      exceptions: false,
      related,
    },
  });

// Hydration rolls up one hop: a related entity's own roll-ups never reach
// the owner, so a chain would silently drop the far entity's gaps.
describe("related data-quality roll-ups", () => {
  it("accepts one hop", () => {
    expect(() =>
      validateDataQualityDeclarations([scored("a", ["b"]), scored("b", [])]),
    ).not.toThrow();
  });

  it.each([
    [[scored("a", ["b"]), scored("b", ["c"]), scored("c", [])]],
    [[scored("a", ["b"]), scored("b", ["a"])]],
  ])("rejects chains and cycles", (entities) => {
    expect(() => validateDataQualityDeclarations(entities)).toThrow(/one hop/);
  });
});

// A readable field alone cannot host a check: the record renderer needs a
// declared field section, otherwise quality navigation points nowhere.
it("rejects quality placement on a readable field omitted from record sections", () => {
  const entity = scored("a", []);
  entity.dataQuality!.checks[0]!.placement = { field: "name" };
  const withoutSections = {
    ...entity,
    inspector: fromPartial<CompiledEntity["inspector"]>({
      detail: { sections: [] },
    }),
  };
  expect(() => validateDataQualityDeclarations([withoutSections])).toThrow(
    /field absent from detail/,
  );
});
