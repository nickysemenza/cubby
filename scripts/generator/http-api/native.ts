import { z } from "zod";
import {
  entityKeys,
  entitySummary,
} from "../../../packages/schemas/src/generated/entity-summary.gen.ts";
import { generatedEntityFieldModels } from "../../../packages/schemas/src/generated/entity-field-model.gen.ts";
import {
  type HeroActionBodyValue,
  type NativeHeroActionPlan,
  nativeCollectionActionPlans,
  nativeHeroActionPlans,
} from "../../../packages/schemas/src/native-coverage.ts";
import { generatedHeader, yamlGeneratedHeader } from "../artifacts.ts";
import type { EntityArtifacts } from "../entities/declarations.ts";
import type { KernelActions } from "../entities/render/index.ts";
import { type EntityOutputs, renderApiTypes } from "./api-types.ts";
import { isObjectSchema, type JsonSchema } from "./document-passes.ts";
import type { OpenApiDocument } from "./openapi.ts";
import { renderClientOperations } from "./swift-operations.ts";
import {
  collectSwiftRoutes,
  operationBodyRef,
  type SwiftRoute,
  swiftList,
  swiftString,
} from "./swift-routes.ts";
import { ADDITIONAL_IMPORTS, TYPE_OVERRIDES } from "./type-overrides.ts";

// The native client's route table is derived from the same document so the
// Swift side never hand-maintains (method, path) pairs. It is committed next
// to the swift-openapi-generator output and gated by the same --check.
const renderOperationRoutes = (
  swiftRoutes: readonly SwiftRoute[],
): EntityArtifacts => ({
  relativePath:
    "apps/apple/CubbyKit/Sources/CubbyKit/Generated/OperationRoutes.swift",
  source: `${generatedHeader}extension OperationRoute {
    /// Every operation in the HTTP API, keyed by operationId.
    public static let all: [String: OperationRoute] = Dictionary(
        uniqueKeysWithValues: routeTable.map { ($0.operationID, $0) }
    )

    private static let routeTable: [OperationRoute] = [
${swiftRoutes
  .map(
    (entry) =>
      `        OperationRoute(operationID: ${swiftString(entry.id)}, method: ${entry.method}, path: ${swiftString(entry.route)}, pathParameters: ${swiftList(entry.pathParameters)}, queryParameters: ${swiftList(entry.queryParameters)}, hasBody: ${entry.hasBody}),`,
  )
  .join("\n")}
    ]
}
`,
});

const renderGeneratorConfig = (): EntityArtifacts => {
  const overrides = Object.entries(TYPE_OVERRIDES).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  const optional = [
    ...(ADDITIONAL_IMPORTS.length > 0
      ? [
          "additionalImports:",
          ...ADDITIONAL_IMPORTS.map((module) => `  - ${module}`),
        ]
      : []),
    ...(overrides.length > 0
      ? [
          "typeOverrides:",
          "  schemas:",
          ...overrides.map(([name, type]) => `    ${name}: ${type}`),
        ]
      : []),
  ]
    .map((line) => `${line}\n`)
    .join("");
  return {
    relativePath:
      "apps/apple/CubbyKit/Sources/CubbyAPI/openapi-generator-config.yaml",
    source: `${yamlGeneratedHeader}# The HTTP document carries only the operations flagged \`native:\` in
# apps/web/src/contracts, so the generator renders all of it unfiltered.
generate:
  - types
  - client
# These land in the CubbyAPI target; \`public\` lets CubbyKit and the App name them
# through the generated aliases in CubbyKit/Generated/APITypes.swift.
accessModifier: public
namingStrategy: idiomatic
${optional}`,
  };
};

/** The top-level keys of a hero-action body template. */
const templateKeys = (body: HeroActionBodyValue): string[] =>
  Object.keys(z.record(z.string(), z.unknown()).catch({}).parse(body));

type PlanContext = {
  document: OpenApiDocument;
  components: Record<string, JsonSchema>;
  swiftRoutes: readonly SwiftRoute[];
  generatedOperationIds: ReadonlySet<string>;
  actions: KernelActions;
};

const bodyProperties = (
  context: PlanContext,
  id: string,
): ReadonlySet<string> | null => {
  const entry = context.swiftRoutes.find((route) => route.id === id);
  const ref =
    entry === undefined
      ? undefined
      : operationBodyRef(context.document, entry.route, entry.method);
  const body = ref === undefined ? undefined : context.components[ref];
  if (body === undefined || !isObjectSchema(body)) return null;
  // A discriminated union (`run.startTargeted`) declares its keys on its members.
  const members = (body.oneOf ?? []).flatMap((member) => {
    const memberRef = isObjectSchema(member) ? member.$ref : undefined;
    const schema = memberRef?.split("/").pop();
    const resolved =
      schema === undefined ? undefined : context.components[schema];
    return resolved !== undefined && isObjectSchema(resolved)
      ? Object.keys(resolved.properties ?? {})
      : [];
  });
  return new Set([...Object.keys(body.properties ?? {}), ...members]);
};

const checkOperationPlan = (
  context: PlanContext,
  verb: string,
  plan: Extract<NativeHeroActionPlan, { kind: "operation" }>,
): string[] => {
  const problems: string[] = [];
  for (const id of [plan.operation, plan.preview?.operation ?? null])
    if (id !== null && !context.generatedOperationIds.has(id))
      problems.push(
        `${verb}: ${id} is not on the generated client (flag its contract member \`native:\`)`,
      );
  const properties = bodyProperties(context, plan.operation);
  for (const key of templateKeys(plan.body))
    if (properties !== null && !properties.has(key))
      problems.push(`${verb}: ${plan.operation} declares no body field ${key}`);
  const fields = new Set(plan.fields.map((field) => field.key));
  const templates = [plan.body, plan.preview?.body ?? null];
  for (const template of templates)
    for (const slot of JSON.stringify(template).match(
      /\$(?:row|item|field)\.[A-Za-z]+/gu,
    ) ?? []) {
      const [prefix, name] = slot.slice(1).split(".");
      if (prefix === "field" ? !fields.has(name ?? "") : name !== "id")
        problems.push(`${verb}: body slot ${slot} has no field`);
    }
  const toggles = new Set(
    plan.fields.filter((field) => field.kind === "toggle").map((f) => f.key),
  );
  for (const field of plan.fields)
    if (field.showWhen !== undefined && !toggles.has(field.showWhen))
      problems.push(
        `${verb}: ${field.key} is shown when ${field.showWhen}, which is not a toggle field`,
      );
  return problems;
};

const checkFieldPlan = (
  verb: string,
  plan: Extract<
    NativeHeroActionPlan,
    { kind: "create" | "setField" | "toggleField" }
  >,
): string[] => {
  const targets = plan.kind === "create" ? [plan.entity] : plan.entities;
  const names = plan.kind === "create" ? Object.keys(plan.seed) : [plan.field];
  return targets.flatMap((entity) => {
    const writable: readonly string[] = [
      ...generatedEntityFieldModels[entity].create,
      ...generatedEntityFieldModels[entity].update,
    ];
    return names
      .filter((name) => !writable.includes(name))
      .map((name) => `${verb}: ${entity} has no writable field ${name}`);
  });
};

/**
 * A hero-action plan names operations the generated client must carry and body keys the
 * operation's request schema declares, so a renamed contract field or a dropped `native:` flag
 * fails `pnpm generate` instead of surfacing as a decode error on a device.
 */
const checkHeroActionPlans = (context: PlanContext) => {
  const plans: Readonly<Record<string, NativeHeroActionPlan>> =
    nativeHeroActionPlans;
  const problems = Object.entries(plans).flatMap(([verb, plan]) => {
    if (plan.kind === "operation")
      return checkOperationPlan(context, verb, plan);
    if (plan.kind !== "delete") return checkFieldPlan(verb, plan);
    // Delete previews connections, then runs through the kernel mutation;
    // every entity whose hero declares delete needs the kernel delete action.
    return [
      ...["entity.connections", "entity.mutate"]
        .filter((id) => !context.generatedOperationIds.has(id))
        .map((id) => `${verb}: ${id} is not on the generated client`),
      ...entityKeys
        .filter(
          (key) =>
            entitySummary[key].detail.hero.actions.some(
              (action) => action === "delete",
            ) && !(context.actions[key] ?? []).includes("delete"),
        )
        .map((key) => `${verb}: ${key} has no kernel delete action`),
    ];
  });
  const collectionPlans: Readonly<Record<string, NativeHeroActionPlan>> =
    nativeCollectionActionPlans;
  problems.push(
    ...Object.entries(collectionPlans).flatMap(([verb, plan]) =>
      plan.kind === "operation"
        ? checkOperationPlan(context, `collection ${verb}`, plan)
        : [`collection ${verb}: only operation plans run from a collection`],
    ),
  );
  if (problems.length > 0)
    throw new Error(
      `nativeHeroActionPlans is invalid:\n${problems.join("\n")}`,
    );
};

/**
 * Everything the native app derives from the OpenAPI document: the route
 * table, the swift-openapi-generator config, the `CubbyClient`
 * pass-through methods and the component aliases. The document carries
 * exactly the `native:` operations.
 */
export const renderNativeArtifacts = (
  document: OpenApiDocument,
  components: Record<string, JsonSchema>,
  actions: KernelActions,
  nativeOperations: readonly string[],
  entityOutputs: EntityOutputs,
): EntityArtifacts[] => {
  const swiftRoutes = collectSwiftRoutes(document);
  const generatedOperationIds = new Set(swiftRoutes.map((route) => route.id));
  const unrouted = nativeOperations.filter(
    (id) => !generatedOperationIds.has(id),
  );
  if (unrouted.length > 0)
    throw new Error(
      `Flagged native but missing from the HTTP document: ${unrouted.join(", ")}`,
    );
  checkHeroActionPlans({
    document,
    components,
    swiftRoutes,
    generatedOperationIds,
    actions,
  });
  return [
    renderOperationRoutes(swiftRoutes),
    renderGeneratorConfig(),
    renderClientOperations(document, swiftRoutes, generatedOperationIds),
    renderApiTypes(components, entityOutputs),
  ];
};
