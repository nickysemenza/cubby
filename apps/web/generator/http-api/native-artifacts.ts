import { z } from "zod";

import { generatedHeader } from "../artifacts.ts";
import type { EntityArtifacts } from "../entities/declarations.ts";
import type { KernelActions } from "../entities/render/index.ts";
import { renderEntityKernelArtifacts } from "./entity-kernel.ts";
import { httpRoutes } from "../../src/lib/http-api/routes.ts";
import { httpMetadataSchema } from "../../src/lib/http-api/router.ts";
import { checkHeroActionPlans } from "./native-plan-validation.ts";
import { collectNativeContract } from "./native-contract.ts";
import { renderNativeCommands } from "./native-commands.ts";
import { renderNativeOperations } from "./native-operations.ts";
import { pascal, registerSchemaNames } from "./schema-names.ts";
import { renderSwiftModels } from "./swift-models.ts";
import { NATIVE_TYPED_RECORDS, TYPE_OVERRIDES } from "./type-overrides.ts";
import { toWire } from "../../src/lib/http-api/wire.ts";

type EntityOutputs = ReadonlyMap<string, string | null>;

/** Native artifacts are derived from declarations, independently of documentation formats. */
export async function renderDirectNativeArtifacts(
  actions: KernelActions,
  nativeOperations: readonly string[],
  entityOutputs: EntityOutputs,
): Promise<EntityArtifacts[]> {
  const named = await registerSchemaNames(
    new URL("../../src/", import.meta.url),
  );
  const { httpContract } =
    await import("../../src/lib/generated/http-contract.gen.ts");
  const { detailEntities, getEntityDetailOutputSchema } =
    await import("../../src/entity/generated/entity-details.gen.ts");
  const records = new Map<string, z.ZodType>();
  for (const name of NATIVE_TYPED_RECORDS) {
    const exported = named.get(name);
    if (exported) {
      records.set(name, toWire(exported, "output"));
      continue;
    }
    const entity = /^(?<entity>[A-Z][a-z]+)Detail$/u.exec(name)?.groups?.entity;
    if (!entity) throw new Error(`Missing native record ${name}`);
    records.set(
      name,
      toWire(
        getEntityDetailOutputSchema(
          z.enum(detailEntities).parse(entity.toLowerCase()),
        ),
        "output",
      ),
    );
  }
  const contract = collectNativeContract(httpContract, named, records);
  const exposed = new Set(contract.operations.map(({ id }) => id));
  if (
    nativeOperations.length !== exposed.size ||
    nativeOperations.some((id) => !exposed.has(id))
  )
    throw new Error("Native operation declarations and HTTP routes disagree");
  const bodies = new Map<string, z.ZodType>();
  for (const route of httpRoutes(httpContract)) {
    if ("body" in route && route.body instanceof z.ZodType)
      bodies.set(
        httpMetadataSchema.parse(route.metadata).operation,
        route.body,
      );
  }
  checkHeroActionPlans({ bodies, generatedOperationIds: exposed, actions });
  const models = renderSwiftModels(contract);
  const aliases = models.names.map(
    (name) => `public typealias ${name} = CubbyAPI.${name}`,
  );
  const photoAliases = {
    PhotoImportContentType: "PhotoImportStageInputItemsItemContentType",
    PhotoImportSourceEntity: "PhotoImportCommitInputImagesItemSourceEntity",
    PhotoImportStageItem: "PhotoImportStageInputItemsItem",
    PhotoImportStageResult: "PhotoImportStageOutputItemsItem",
    PhotoImportStageExisting: "PhotoImportStageOutputItemsItemVariant1",
    PhotoImportStageUpload: "PhotoImportStageOutputItemsItemVariant2",
    PhotoImportCommitImage: "PhotoImportCommitInputImagesItem",
    PhotoImportSourcePayload: "PhotoImportCommitInputImagesItemSource",
    PhotoImportDuplicateDecisionPayload:
      "PhotoImportCommitInputImagesItemDuplicateDecision",
    PhotoImportCommitDestination: "PhotoImportCommitInputImagesItemDestination",
    PhotoImportExistingDestination:
      "PhotoImportCommitInputImagesItemDestinationVariant1",
    PhotoImportCreateDestination:
      "PhotoImportCommitInputImagesItemDestinationVariant2",
    PhotoImportAnalysisPayload: "PhotoImportCommitInputImagesItemAnalysis",
    PhotoImportClassificationPayload:
      "PhotoImportCommitInputImagesItemAnalysisClassificationsItem",
    PhotoImportRecognizedTextPayload:
      "PhotoImportCommitInputImagesItemAnalysisRecognizedTextItem",
    PhotoImportFeaturePrintPayload:
      "PhotoImportCommitInputImagesItemAnalysisFeaturePrint",
    PhotoImportProvenancePayload:
      "PhotoImportCommitInputImagesItemAnalysisProvenance",
    PhotoImportCreatePayload: "PhotoImportCommitInputCreatesItem",
  };
  for (const [alias, model] of Object.entries(photoAliases)) {
    if (!models.names.includes(model))
      throw new Error(`Missing native photo model ${model}`);
    aliases.push(`public typealias ${alias} = CubbyAPI.${model}`);
  }
  for (const [name, type] of Object.entries(TYPE_OVERRIDES)) {
    if (
      models.types.has(`native://input/${name}`) ||
      models.types.has(`native://output/${name}`)
    )
      aliases.push(`public typealias ${name} = ${type}`);
  }
  for (const [entity, output] of entityOutputs) {
    if (output === null) continue;
    const model = models.types.get(`native://output/${pascal(output)}`);
    const base = pascal(entity);
    const alias = base === "Task" || base === "Image" ? `${base}Record` : base;
    if (model && !models.names.includes(alias))
      aliases.push(`public typealias ${alias} = CubbyAPI.${model}`);
  }
  const identifiable = [...models.types].flatMap(([ref, name]) => {
    if (!ref.startsWith("native://output/") || ref.includes("#")) return [];
    const schema = contract.models[ref.slice("native://".length)];
    return schema?.properties?.id && models.names.includes(name)
      ? [`extension CubbyAPI.${name}: Identifiable {}`]
      : [];
  });
  return [
    ...models.artifacts,
    ...renderNativeOperations(contract, models),
    renderNativeCommands(contract),
    ...renderEntityKernelArtifacts(actions, nativeOperations),
    {
      relativePath:
        "apps/apple/CubbyKit/Sources/CubbyKit/Generated/APITypes.swift",
      source: `${generatedHeader}// swift-format-ignore-file\nimport CubbyAPI\nimport CubbyAPISupport\n\n${aliases.join("\n")}\n\n${[...new Set(identifiable)].join("\n")}\n`,
    },
  ];
}
