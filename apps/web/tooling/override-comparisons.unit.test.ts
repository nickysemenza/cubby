import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  compileLoadedEntityDeclarations,
  loadEntityDeclarationBundle,
} from "../../../scripts/generator/entities/declarations";
import { renderOverrideComparisonArtifact } from "../../../scripts/generator/entities/override-comparisons";

const declarationObject = z.record(z.string(), z.unknown());

describe("override comparisons", () => {
  let declarations: Awaited<
    ReturnType<typeof loadEntityDeclarationBundle>
  >["declarations"];
  let compiled: ReturnType<typeof compileLoadedEntityDeclarations>;
  beforeAll(async () => {
    ({ declarations } = await loadEntityDeclarationBundle());

    // Location's `children` table already infers `{ descriptor: "parent" }`;
    // declaring the same filter changes nothing and must not pass generation.
    declarations = declarations.map((raw) => {
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

    compiled = compileLoadedEntityDeclarations(declarations)
      .filter((entity) => entity.key === "location")
      .map((entity) => ({
        ...entity,
        overrides: entity.overrides.filter(
          ({ path }) => path === "presentation.detail.relationFilterOverrides",
        ),
      }));
  });
  it("refuses a relation filter override that repeats the inferred filter", () => {
    expect(() =>
      renderOverrideComparisonArtifact(declarations, compiled),
    ).toThrow("location.presentation.detail.relationFilterOverrides");
  });
});
