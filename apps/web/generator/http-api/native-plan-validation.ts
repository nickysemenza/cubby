import { z } from "zod";
import { entityKeys, entitySummary } from "@cubby/schemas/entity-summary";
import { generatedEntityFieldModels } from "@cubby/schemas/compiler/generated/entity-field-model.gen";
import {
  type HeroActionBodyValue,
  type NativeHeroActionPlan,
  nativeCollectionActionPlans,
  nativeHeroActionPlans,
} from "@cubby/schemas/compiler/native-coverage";
import type { KernelActions } from "../entities/render/index.ts";

/** The top-level keys of a hero-action body template. */
const templateKeys = (body: HeroActionBodyValue): string[] =>
  Object.keys(z.record(z.string(), z.unknown()).catch({}).parse(body));

type PlanContext = {
  bodies: ReadonlyMap<string, z.ZodType>;
  generatedOperationIds: ReadonlySet<string>;
  actions: KernelActions;
};

const bodyProperties = (
  context: PlanContext,
  id: string,
): ReadonlySet<string> | null => {
  const body = context.bodies.get(id);
  if (!body) return null;
  const schema = z.toJSONSchema(body, { io: "input" });
  const keys = (node: z.core.JSONSchema.JSONSchema | boolean): string[] => {
    if (typeof node !== "object") return [];
    if (node.$ref?.startsWith("#/$defs/")) {
      const target = schema.$defs?.[node.$ref.slice("#/$defs/".length)];
      return target ? keys(target) : [];
    }
    return [
      ...Object.keys(node.properties ?? {}),
      ...(node.oneOf ?? node.anyOf ?? []).flatMap(keys),
    ];
  };
  const properties = keys(schema);
  return properties.length > 0 ? new Set(properties) : null;
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
        `${verb}: ${id} is not on the generated client (operation contracts expose every query and mutation)`,
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
    { kind: "create" | "setField" | "editField" | "toggleField" }
  >,
): string[] => {
  const targets = plan.kind === "create" ? [plan.entity] : plan.entities;
  const names = plan.kind === "create" ? Object.keys(plan.seed) : [plan.field];
  return targets.flatMap((entity) => {
    const model = generatedEntityFieldModels[entity];
    // An edit of an existing record writes through the update contract only.
    const writable: readonly string[] =
      plan.kind === "editField"
        ? model.update
        : [...model.create, ...model.update];
    const problems = names
      .filter((name) => !writable.includes(name))
      .map((name) => `${verb}: ${entity} has no writable field ${name}`);
    if (plan.kind === "setField" && plan.value !== undefined) {
      const options: readonly { value: string }[] =
        model.fields.find((field) => field.key === plan.field)?.control
          ?.options ?? [];
      if (!options.some((option) => option.value === plan.value))
        problems.push(
          `${verb}: ${plan.value} is not a ${entity}.${plan.field} option`,
        );
    }
    return problems;
  });
};

/**
 * A hero-action plan names operations the generated client must carry and body keys the
 * operation's request schema declares, so a renamed contract field fails
 * `pnpm generate` instead of surfacing as a decode error on a device.
 */
export const checkHeroActionPlans = (context: PlanContext) => {
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
