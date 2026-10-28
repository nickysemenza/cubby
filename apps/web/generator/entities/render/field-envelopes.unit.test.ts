import { renderSchemaWrapperArtifacts } from "./schema-wrappers.ts";
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
  it("builds a stored source declaration without a repository port and refuses unsupported ordinary writes", async () => {
    const { declarations } = await loadEntityDeclarationBundle();
    const source = z
      .looseObject({
        extensions: z.looseObject({ ports: z.looseObject({}) }),
        capabilities: z.looseObject({}),
        model: z.looseObject({}),
      })
      .parse(
        declarations.find((declaration) => declaration.key === "ledgerParty"),
      );
    const compiled = compileEntity(
      {
        ...source,
        extensions: {
          ...source.extensions,
          ports: { ...source.extensions.ports, repository: undefined },
        },
        capabilities: { ...source.capabilities, merge: false },
        model: { ...source.model, intents: undefined },
      },
      0,
    );
    expect(compiled.fieldModel.intents).toMatchObject({
      fields: {
        create: compiled.fieldModel.create,
        full: compiled.fieldModel.update,
      },
      create: ["create"],
      update: ["full"],
    });
    const referenceSource = z
      .looseObject({
        extensions: z.looseObject({ ports: z.looseObject({}) }),
        filters: z.looseObject({
          descriptors: z.array(z.looseObject({ columnId: z.string() })),
        }),
      })
      .parse(
        declarations.find((declaration) => declaration.key === "planting"),
      );
    const references = compileEntity(
      {
        ...referenceSource,
        extensions: {
          ...referenceSource.extensions,
          ports: { ...referenceSource.extensions.ports, repository: undefined },
        },
        filters: {
          ...referenceSource.filters,
          descriptors: referenceSource.filters.descriptors.filter(
            (descriptor) => descriptor.columnId !== "locationId",
          ),
        },
      },
      0,
    );
    expect(
      references.filterDescriptors.find(
        (descriptor) => descriptor.columnId === "locationId",
      ),
    ).toMatchObject({
      kind: "idMulti",
      brandRef: { entity: "location" },
      stored: { columns: ["locationId"] },
      deriveSchema: true,
    });
    const artifacts = renderKernelBindingsArtifacts([compiled]);
    const runtime = artifacts.find((artifact) =>
      artifact.relativePath.endsWith("entity-kernel-bindings.gen.ts"),
    );
    expect(runtime?.source).toContain("createLedgerPartyDefaultRepository");
    expect(runtime?.source).toContain(
      "ledgerPartyDefaultRepository = createLedgerPartyDefaultRepository()",
    );
    expect(runtime?.source).toContain(".createWriter(ENTITY_STORED_WRITES");
    expect(runtime?.source).toContain(".updateWriter(ENTITY_STORED_WRITES");
    expect(() =>
      renderKernelBindingsArtifacts([
        {
          ...compiled,
          fieldModel: {
            ...compiled.fieldModel,
            create: [...compiled.fieldModel.create, "unsupportedProjection"],
          },
        },
      ]),
    ).toThrow("cannot prepare all declared stored fields");
    expect(() =>
      renderKernelBindingsArtifacts([
        {
          ...compiled,
          readFields: [...compiled.readFields, "domainProjection"],
        },
      ]),
    ).toThrow("cannot read undeclared stored projections (domainProjection)");
    expect(() =>
      renderKernelBindingsArtifacts([
        {
          ...compiled,
          listScopes: {
            scope: [],
            scopes: { domain: { via: "domain", filters: "ledgerParty" } },
          },
        },
      ]),
    ).toThrow("requires domain list bindings (domain)");
  });
  it("rejects stored-result projections whose path or scalar type cannot exist", async () => {
    const { declarations } = await loadEntityDeclarationBundle();
    const shipment = z
      .looseObject({
        model: z.looseObject({ derived: z.record(z.string(), z.unknown()) }),
      })
      .parse(
        declarations.find((declaration) => declaration.key === "shipment"),
      );
    const project = (path: string[]) =>
      compileEntity(
        {
          ...shipment,
          model: {
            ...shipment.model,
            derived: {
              ...shipment.model.derived,
              eventCount: {
                type: "number",
                fromResult: { key: "eventSummary", path },
              },
            },
          },
        },
        0,
      );
    expect(() => project(["missingCount"])).toThrow("fromResult path");
    expect(() => project(["firstEventDate"])).toThrow(
      "does not match the declared number projection",
    );
  });
  it("publishes canonical wrappers while declaration inputs remain raw", async () => {
    const entities = await loadEntityDeclarations();
    const wrappers = renderSchemaWrapperArtifacts(entities);
    expect(
      entities.find((entity) => entity.key === "recipe")?.contract?.list,
    ).toMatchObject({
      module: "@cubby/schemas/entity-contracts/recipe",
      export: "recipeRawListItemOut",
    });
    for (const artifact of wrappers) {
      expect(artifact.source).not.toContain("definition.readSchemas");
      expect(artifact.source).not.toContain("withEntityListMedia");
    }
    const planting = wrappers.find((artifact) =>
      artifact.relativePath.endsWith("/planting.gen.ts"),
    );
    expect(planting?.source).toContain(
      "plantingOut = plantingFieldEnvelopeSchemas.output",
    );
    expect(planting?.source).toContain(
      "plantingListItemOut = plantingFieldEnvelopeSchemas.list",
    );
    expect(
      entities.find((entity) => entity.key === "planting")?.contract?.output,
    ).toMatchObject({
      module: "@cubby/schemas/entity-contracts/planting",
      export: "plantingRawOut",
    });
  });
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

  it("envelopes shared Image attachments without making raw declarations depend on media", async () => {
    const artifacts = renderFieldEnvelopeArtifacts(
      await loadEntityDeclarations(),
    );
    const leaf = artifacts.find((artifact) =>
      artifact.relativePath.endsWith("entity-image-attachment.gen.ts"),
    );
    expect(leaf?.source).toContain(
      "withFieldEnvelopes(rawImageOutput, imageFieldEnvelopeFields, imagePublicReadFields)",
    );
    expect(leaf?.source).not.toContain("entity-read-media");
    const product = artifacts.find((artifact) =>
      artifact.relativePath.endsWith("entity-field-envelopes.product.gen.ts"),
    );
    expect(product?.source).toContain(
      'shape["images"].element, imageFieldEnvelopeFields, imagePublicReadFields',
    );
    expect(product?.source).toContain(
      'shape["labelImages"].element, imageFieldEnvelopeFields, imagePublicReadFields',
    );
    const inventory = artifacts.find((artifact) =>
      artifact.relativePath.endsWith("entity-field-envelopes.inventory.gen.ts"),
    );
    expect(inventory?.source).toContain(
      'shape["product"].shape["images"].element, imageFieldEnvelopeFields, imagePublicReadFields',
    );
    const nested = artifacts.find((artifact) =>
      artifact.relativePath.endsWith("entity-field-envelope-nested.gen.ts"),
    );
    expect(nested?.source).toContain('{"path":["images"],"entity":"image"}');
  });

  it("rejects a live Image leaf without its declared embedding", async () => {
    const entities = await loadEntityDeclarations();
    expect(() =>
      renderFieldEnvelopeArtifacts(
        entities.map((entity) =>
          entity.key === "product" && entity.contract
            ? {
                ...entity,
                contract: {
                  ...entity.contract,
                  embedded: entity.contract.embedded.filter(
                    (binding) => binding.path.join(".") !== "images",
                  ),
                },
              }
            : entity,
        ),
      ),
    ).toThrow("product.images requires a declared image embedding");
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
          ...location.contract.embedded,
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
