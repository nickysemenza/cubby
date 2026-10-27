import { describe, expect, it } from "vitest";
import { z } from "zod";

import { compileEntity } from "../compile.ts";
import { renderKernelBindingsArtifacts } from "./kernel-bindings.ts";
import {
  loadEntityDeclarations,
  loadEntityDeclarationBundle,
} from "../declarations.ts";
import { renderFieldEnvelopeArtifacts } from "./field-envelopes.ts";

describe("recursive field projections", () => {
  it("emits a typed lazy Location fixpoint without expanding Recipe scalar snapshots", async () => {
    const artifacts = renderFieldEnvelopeArtifacts(
      await loadEntityDeclarations(),
    );
    const location = artifacts.find((artifact) =>
      artifact.relativePath.endsWith("entity-field-envelopes.location.gen.ts"),
    );
    const recipe = artifacts.find((artifact) =>
      artifact.relativePath.endsWith("entity-field-envelopes.recipe.gen.ts"),
    );
    expect(location?.source).toContain("type locationdetailNode =");
    expect(location?.source).toContain(
      "z.lazy((): z.ZodType<locationdetailNode[]> => detailEnvelopeRead.array())",
    );
    expect(location?.source).toContain(
      "z.lazy((): z.ZodType<locationdetailNode> => detailEnvelopeRead)",
    );
    expect(recipe?.source).not.toContain("recipedetailNode");
  });

  it("emits declared domain envelope ports without importing repository adapters", async () => {
    const entities = await loadEntityDeclarations();
    const port = renderFieldEnvelopeArtifacts(entities).find((artifact) =>
      artifact.relativePath.endsWith("entity-field-envelope-projectors.gen.ts"),
    );
    expect(port?.source).toContain(
      'from "~/server/domains/product/repo/field-envelope"',
    );
    expect(port?.source).toContain('"product":productFieldEnvelopeProjector');
    expect(port?.source).not.toContain("productRepository");
    const checks = renderKernelBindingsArtifacts(entities).filter((artifact) =>
      artifact.relativePath.includes("entity-port-checks"),
    );
    expect(checks.map((artifact) => artifact.source).join("\n")).toContain(
      "projectProductFieldEnvelopes",
    );
  });

  it("rejects a public snapshot alias that names no published derived value", async () => {
    const { declarations } = await loadEntityDeclarationBundle();
    const locationDefinition = z
      .looseObject({
        model: z.looseObject({
          fields: z.array(z.looseObject({ key: z.string() })),
        }),
      })
      .parse(
        declarations.find((declaration) => declaration.key === "location"),
      );
    expect(() =>
      compileEntity(
        {
          ...locationDefinition,
          model: {
            ...locationDefinition.model,
            fields: locationDefinition.model.fields.map((field) =>
              field.key === "valuation"
                ? { ...field, storedKey: "missingSnapshot" }
                : field,
            ),
          },
        },
        0,
      ),
    ).toThrow("storedKey must name a published stored derived value");
  });

  it("rejects recursive edges targeting another entity", async () => {
    const entities = await loadEntityDeclarations();
    const location = entities.find((entity) => entity.key === "location");
    if (!location?.contract)
      throw new Error("Expected the Location declaration");
    const invalid = {
      ...location,
      contract: {
        ...location.contract,
        embedded: [
          {
            path: ["product"],
            entity: "product",
            recursive: true,
            projections: ["detail" as const],
          },
        ],
      },
    };
    expect(() =>
      renderFieldEnvelopeArtifacts(
        entities.map((entity) =>
          entity.key === "location" ? invalid : entity,
        ),
      ),
    ).toThrow("recursive embeddings require a direct self edge");
  });
});
