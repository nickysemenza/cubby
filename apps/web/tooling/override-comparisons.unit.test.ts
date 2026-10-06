import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  compileLoadedEntityDeclarations,
  loadEntityDeclarationBundle,
} from "../../../scripts/generator/entities/declarations";
import { renderOverrideComparisonArtifact } from "../../../scripts/generator/entities/override-comparisons";

const declarationObject = z.record(z.string(), z.unknown());

describe("override comparisons", () => {
  it("refuses a relation filter override that repeats the inferred filter", async () => {
    const { declarations } = await loadEntityDeclarationBundle();
    // Location's `children` table already infers `{ descriptor: "parent" }`;
    // declaring the same filter changes nothing and must not pass generation.
    const changed = declarations.map((raw) => {
      if (raw.key !== "location") return raw;
      const presentation = declarationObject.parse(raw.presentation);
      return {
        ...raw,
        presentation: {
          ...presentation,
          detail: {
            ...declarationObject.parse(presentation.detail),
            relationFilterOverrides: { children: { descriptor: "parent" } },
          },
        },
      };
    });

    expect(() =>
      renderOverrideComparisonArtifact(
        changed,
        compileLoadedEntityDeclarations(changed),
      ),
    ).toThrow("location.presentation.detail.relationFilterOverrides");
  });
});
