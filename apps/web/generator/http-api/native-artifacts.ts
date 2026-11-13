import { fileURLToPath } from "node:url";
import { z } from "zod";

import { generatedHeader } from "../artifacts.ts";
import type {
  CompiledEntity,
  EntityArtifacts,
} from "../entities/declarations.ts";
import type { KernelActions } from "../entities/render/index.ts";
import { renderEntityKernelArtifacts } from "./entity-kernel.ts";
import { loadContracts } from "../operations/collect.ts";
import { checkHeroActionPlans } from "./native-plan-validation.ts";
import { collectNativeContract } from "./native-contract.ts";
import { renderNativeCommands } from "./native-commands.ts";
import { CLIENT_PASSTHROUGH_METHODS } from "./native-methods.ts";
import { renderNativeOperations, swiftId } from "./native-operations.ts";
import { registerSchemaNames } from "./schema-names.ts";
import { scanSwiftCallers } from "./swift-callers.ts";
import { renderSwiftModels } from "./swift-models.ts";
import { NATIVE_TYPED_RECORDS } from "./type-overrides.ts";

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
  _entityOutputs: EntityOutputs,
  entities: readonly CompiledEntity[],
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
      id.startsWith("machinery.") ||
      callers.operationIds.has(id) ||
      callers.tokens.has(`native_${swiftId(id)}`) ||
      (passthrough[id] !== undefined &&
        callers.tokens.has(passthrough[id].method)),
  );
  const fullModels = renderSwiftModels(contract, callers.tokens);
  const modelOf = (reference: string) =>
    fullModels.types.get(`native://${reference}`);
  // Roots: what kept operations reach, record roots, and any model named
  // in handwritten Swift. Inferred types are reached through the operation closure.
  const models = fullModels.prune(
    [
      ...typedOperations.flatMap(({ body, output }) => [
        ...(body ? [modelOf(body)] : []),
        modelOf(output),
      ]),
      ...contract.records.map(modelOf),
      ...fullModels.names.filter((name) => callers.tokens.has(name)),
    ].filter((name) => name !== undefined),
  );
  const identifiable = [...models.types].flatMap(([ref, name]) => {
    if (!ref.startsWith("native://output/") || ref.includes("#")) return [];
    const schema = contract.models[ref.slice("native://".length)];
    return schema?.properties?.id && models.names.includes(name)
      ? [`extension ${name}: Identifiable {}`]
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
    ...renderEntityKernelArtifacts(actions, operationIds, entities),
    {
      relativePath:
        "apps/apple/CubbyKit/Sources/CubbyAPI/Models/native-identifiable.gen.swift",
      source: `${generatedHeader}// swift-format-ignore-file\n${[...new Set(identifiable)].join("\n")}\n`,
    },
  ];
}
