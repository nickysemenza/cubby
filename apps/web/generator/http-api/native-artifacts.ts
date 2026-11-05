import { fileURLToPath } from "node:url";
import { z } from "zod";

import { generatedHeader } from "../artifacts.ts";
import type { EntityArtifacts } from "../entities/declarations.ts";
import type { KernelActions } from "../entities/render/index.ts";
import { renderEntityKernelArtifacts } from "./entity-kernel.ts";
import { loadContracts } from "../operations/collect.ts";
import { checkHeroActionPlans } from "./native-plan-validation.ts";
import { collectNativeContract } from "./native-contract.ts";
import { renderNativeCommands } from "./native-commands.ts";
import { CLIENT_PASSTHROUGH_METHODS } from "./native-methods.ts";
import { renderNativeOperations, swiftId } from "./native-operations.ts";
import { pascal, registerSchemaNames } from "./schema-names.ts";
import { scanSwiftCallers } from "./swift-callers.ts";
import { renderSwiftModels } from "./swift-models.ts";
import { NATIVE_TYPED_RECORDS, TYPE_OVERRIDES } from "./type-overrides.ts";

type EntityOutputs = ReadonlyMap<string, string | null>;

// Device callers depend on these exact wire names, so the scan cannot drop them.
const ALWAYS_TYPED_OPERATIONS = new Set([
  "job.deviceBacklog",
  "run.reportDeviceWork",
]);

/** Native artifacts are derived from declarations, independently of documentation formats. */
export async function renderDirectNativeArtifacts(
  actions: KernelActions,
  operationIds: readonly string[],
  entityOutputs: EntityOutputs,
): Promise<EntityArtifacts[]> {
  const named = await registerSchemaNames(
    new URL("../../src/", import.meta.url),
  );
  const contracts = await loadContracts();
  const { detailEntities, getEntityDetailOutputSchema } =
    await import("../../src/server/entity-reads/detail-contracts.ts");
  const records = new Map<string, z.ZodType>();
  for (const name of NATIVE_TYPED_RECORDS) {
    const exported = named.get(name);
    if (exported) {
      records.set(name, exported);
      continue;
    }
    const entity = /^(?<entity>[A-Z][a-z]+)Detail$/u.exec(name)?.groups?.entity;
    if (!entity) throw new Error(`Missing native record ${name}`);
    records.set(
      name,
      getEntityDetailOutputSchema(
        z.enum(detailEntities).parse(entity.toLowerCase()),
      ),
    );
  }
  const contract = collectNativeContract(
    contracts,
    records,
    named,
    operationIds,
  );
  const exposed = new Set(contract.operations.map(({ id }) => id));
  if (
    operationIds.length !== exposed.size ||
    operationIds.some((id) => !exposed.has(id))
  )
    throw new Error("Operation ids and contract members disagree");
  const bodies = new Map<string, z.ZodType>();
  const httpOperations = new Set(operationIds);
  for (const { contract: declaration } of contracts) {
    for (const [member, definition] of Object.entries(declaration.ops)) {
      if (
        definition.kind !== "subscription" &&
        httpOperations.has(`${declaration.domain}.${member}`) &&
        definition.input instanceof z.ZodType
      ) {
        bodies.set(
          `${declaration.domain}.${member}`,
          definition.operationWire?.input ?? definition.input,
        );
      }
    }
  }
  checkHeroActionPlans({ bodies, generatedOperationIds: exposed, actions });
  const missing = [...ALWAYS_TYPED_OPERATIONS].filter((id) => !exposed.has(id));
  if (missing.length > 0)
    throw new Error(
      `Missing required native operations: ${missing.join(", ")}`,
    );
  const callers = scanSwiftCallers(
    fileURLToPath(new URL("../../../apple/", import.meta.url)),
  );
  const passthrough: Readonly<Record<string, { method: string }>> =
    CLIENT_PASSTHROUGH_METHODS;
  const typedOperations = contract.operations.filter(
    ({ id }) =>
      ALWAYS_TYPED_OPERATIONS.has(id) ||
      callers.operationIds.has(id) ||
      callers.tokens.has(`native_${swiftId(id)}`) ||
      (passthrough[id] !== undefined &&
        callers.tokens.has(passthrough[id].method)),
  );
  const fullModels = renderSwiftModels(contract);
  const modelOf = (reference: string) =>
    fullModels.types.get(`native://${reference}`);
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
  for (const model of Object.values(photoAliases))
    if (!fullModels.names.includes(model))
      throw new Error(`Missing native photo model ${model}`);
  const entityAlias = (entity: string) => {
    const base = pascal(entity);
    return base === "Task" || base === "Image" ? `${base}Record` : base;
  };
  // Roots: what kept operations reach, record roots, and any model or alias named
  // in handwritten Swift. Inferred types are reached through the operation closure.
  const models = fullModels.prune(
    [
      ...typedOperations.flatMap(({ body, output }) => [
        ...(body ? [modelOf(body)] : []),
        modelOf(output),
      ]),
      ...contract.records.map(modelOf),
      ...fullModels.names.filter((name) => callers.tokens.has(name)),
      ...Object.entries(photoAliases)
        .filter(([alias]) => callers.tokens.has(alias))
        .map(([, model]) => model),
      ...[...entityOutputs].flatMap(([entity, output]) =>
        output !== null && callers.tokens.has(entityAlias(entity))
          ? [modelOf(`output/${pascal(output)}`)]
          : [],
      ),
    ].filter((name) => name !== undefined),
  );
  const aliases = models.names.map(
    (name) => `public typealias ${name} = CubbyAPI.${name}`,
  );
  // Record roots can share a registered schema with a differently named operation
  // output. Keep the requested native API name without projecting a second model.
  for (const [index, alias] of [...records.keys()].entries()) {
    const reference = contract.records[index];
    const model = reference && models.types.get(`native://${reference}`);
    if (!model) throw new Error(`Missing native record model ${alias}`);
    if (model !== alias && !models.names.includes(alias))
      aliases.push(`public typealias ${alias} = CubbyAPI.${model}`);
  }
  for (const [alias, model] of Object.entries(photoAliases))
    if (models.names.includes(model))
      aliases.push(`public typealias ${alias} = CubbyAPI.${model}`);
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
    const alias = entityAlias(entity);
    if (model && models.names.includes(model) && !models.names.includes(alias))
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
    ...renderNativeOperations(
      contract,
      new Set(typedOperations.map(({ id }) => id)),
      models,
    ),
    renderNativeCommands(contract),
    ...renderEntityKernelArtifacts(actions, operationIds),
    {
      relativePath:
        "apps/apple/CubbyKit/Sources/CubbyKit/Generated/APITypes.swift",
      source: `${generatedHeader}// swift-format-ignore-file\nimport CubbyAPI\nimport CubbyAPISupport\n\n${aliases.join("\n")}\n\n${[...new Set(identifiable)].join("\n")}\n`,
    },
  ];
}
