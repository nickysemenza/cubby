import { type EntityEditRegistry, getEntityEditDefinition } from "./registry";
import type {
  EditableEntity,
  EntityEditAccess,
  EntityEditBuildResult,
  EntityEditContext,
  EntityEditDefinition,
  EntityEditIntentDefinition,
  EntityEditIssue,
  EntityEditOperationDefinition,
  EntityEditRecord,
  EntityEditValueSource,
  EntityEditValueBag,
  RuntimeEntityEditRequest,
} from "./types";
import { entityEditValueBagSchema } from "./value-schema";

const EMPTY_CONTEXT: EntityEditContext = {};
type EntityEditDefaultsFactory = (
  context: EntityEditContext,
) => Readonly<EntityEditValueBag>;
const isDefaultsFactory = (
  value: EntityEditIntentDefinition<
    EditableEntity,
    EntityEditRecord
  >["defaults"],
): value is EntityEditDefaultsFactory => typeof value === "function";

export interface ResolvedEntityEdit<E extends EditableEntity = EditableEntity> {
  definition: EntityEditDefinition<E, EntityEditRecord>;
  operation: EntityEditOperationDefinition<E, EntityEditRecord>;
  intentDefinition: EntityEditIntentDefinition<E, EntityEditRecord>;
  intent: string;
  fields: EntityEditDefinition<E, EntityEditRecord>["fields"];
  context: EntityEditContext;
}

const issue = (message: string): EntityEditIssue => ({
  message,
  source: "client",
});

const denied = (access: EntityEditAccess): EntityEditIssue =>
  issue(access.mode === "editable" ? "" : access.reason);

/** Resolve all declarative choices before draft creation or mutation work. */
export function resolveEntityEdit<E extends EditableEntity>(
  registry: EntityEditRegistry,
  request: RuntimeEntityEditRequest<E>,
): ResolvedEntityEdit<E> | { issues: readonly EntityEditIssue[] } {
  const definition = getEntityEditDefinition(registry, request.entity);
  const operation = definition.operations[request.operation];
  if (!operation) {
    return {
      issues: [
        issue(`${request.entity} does not support ${request.operation}.`),
      ],
    };
  }

  const intent = request.intent ?? operation.defaultIntent;
  const intentDefinition = operation.intents[intent];
  if (!intentDefinition) {
    return {
      issues: [
        issue(
          `${request.entity} does not support the ${intent} ${request.operation} intent.`,
        ),
      ],
    };
  }

  const requestedFields = intentDefinition.fields;
  const byId = new Map(definition.fields.map((field) => [field.id, field]));
  const fields = requestedFields.map((fieldId) => byId.get(fieldId));
  const missing = requestedFields.filter((_, index) => !fields[index]);
  if (missing.length > 0) {
    return {
      issues: [
        issue(
          `${request.entity}'s ${request.surface} surface references missing fields: ${missing.join(", ")}.`,
        ),
      ],
    };
  }

  return {
    definition,
    operation,
    intentDefinition,
    intent,
    fields: fields.filter(
      (
        field,
      ): field is EntityEditDefinition<E, EntityEditRecord>["fields"][number] =>
        field !== undefined,
    ),
    context: request.context ?? EMPTY_CONTEXT,
  };
}

export function isResolvedEntityEdit<E extends EditableEntity>(
  value: ResolvedEntityEdit<E> | { issues: readonly EntityEditIssue[] },
): value is ResolvedEntityEdit<E> {
  return "definition" in value;
}

/** Build one stable initial-value bag for a selected semantic surface. */
export function initialEntityEditValues<E extends EditableEntity>(
  resolved: ResolvedEntityEdit<E>,
  request: RuntimeEntityEditRequest<E>,
): EntityEditValueBag {
  const intent = resolved.intentDefinition;
  const defaults = isDefaultsFactory(intent.defaults)
    ? intent.defaults(resolved.context)
    : (intent.defaults ?? {});
  const values: EntityEditValueBag = {
    ...Object.fromEntries(
      resolved.fields.map((field) => [
        field.id,
        field.initial({
          operation: request.operation,
          intent: resolved.intent,
          surface: request.surface,
          record: request.record,
          context: resolved.context,
        }),
      ]),
    ),
    ...defaults,
  };
  // A seed only exists when a caller explicitly supplied one, so every
  // operation merges it unconditionally rather than requiring per-intent
  // opt-in.
  Object.assign(values, request.seed);
  return values;
}

/**
 * Normalize and validate all selected semantic fields, then let the entity
 * intent build its server command. No UI code gets to hand-shape a patch.
 */
export function buildEntityEdit<E extends EditableEntity>(
  resolved: ResolvedEntityEdit<E>,
  request: RuntimeEntityEditRequest<E>,
  values: EntityEditValueSource<E>,
): EntityEditBuildResult<E> {
  const parsedValues = entityEditValueBagSchema.parse(values);
  const intent = resolved.intentDefinition;
  const operationAccess = intent.access({
    surface: request.surface,
    record: request.record,
    context: resolved.context,
  });
  if (operationAccess.mode !== "editable") {
    return { ok: false, issues: [denied(operationAccess)] };
  }

  const normalized: EntityEditValueBag = {};
  const issues: EntityEditIssue[] = [];
  const patches: object[] = [];
  const patchKeys = new Set<string>();

  for (const field of resolved.fields) {
    const fieldAccess = field.access({
      operation: request.operation,
      intent: resolved.intent,
      surface: request.surface,
      record: request.record,
      context: resolved.context,
    });
    if (fieldAccess.mode !== "editable") {
      issues.push({ ...denied(fieldAccess), field: field.id });
      continue;
    }
    normalized[field.id] = field.normalize(parsedValues[field.id]);
  }

  for (const field of resolved.fields) {
    if (!(field.id in normalized)) continue;
    issues.push(
      ...field.validate({
        value: normalized[field.id],
        values: normalized,
        record: request.record,
        context: resolved.context,
      }),
    );
  }
  issues.push(
    ...(intent.validate?.({
      values: normalized,
      record: request.record,
      context: resolved.context,
      surface: request.surface,
    }) ?? []),
  );
  if (issues.length > 0) return { ok: false, issues };

  for (const field of resolved.fields) {
    if (!(field.id in normalized)) continue;
    const patch = field.toPatch({
      value: normalized[field.id],
      operation: request.operation,
      intent: resolved.intent,
      surface: request.surface,
      record: request.record,
      context: resolved.context,
    });
    if (!patch) continue;
    for (const key of Object.keys(patch)) {
      if (patchKeys.has(key)) {
        return {
          ok: false,
          issues: [
            issue(
              `${request.entity}'s ${resolved.intent} intent has conflicting patch contributors for ${key}.`,
            ),
          ],
        };
      }
      patchKeys.add(key);
    }
    patches.push(patch);
  }

  const patch = Object.assign({}, ...patches);
  return intent.build({
    record: request.record,
    patch,
    context: resolved.context,
  });
}
