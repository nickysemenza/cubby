import type { QueryKey } from "@tanstack/react-query";
import { type EntityEditRegistry, getEntityEditDefinition } from "./registry";
import type {
  EditableEntity,
  EntityEditAccess,
  EntityEditBuildResult,
  EntityEditCommand,
  EntityEditContext,
  EntityEditDefinition,
  EntityEditField,
  EntityEditIntentDefinition,
  EntityEditIssue,
  EntityEditOperationDefinition,
  EntityEditRecord,
  EntityEditRequest,
  EntityEditResult,
  EntityEditSurfaceRecipe,
  EntityMutationPort,
} from "./types";

const EMPTY_CONTEXT: EntityEditContext = {};

export interface ResolvedEntityEdit<E extends EditableEntity = EditableEntity> {
  definition: EntityEditDefinition<E>;
  operation: EntityEditOperationDefinition<E, EntityEditRecord>;
  intentDefinition: EntityEditIntentDefinition<E, EntityEditRecord>;
  recipe?: EntityEditSurfaceRecipe;
  intent: string;
  fields: readonly EntityEditField<E, EntityEditRecord, unknown, object>[];
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
  request: EntityEditRequest<E>,
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

  const recipe = definition.surfaces[request.surface];
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
    recipe,
    intent,
    fields: fields as readonly EntityEditField<
      E,
      EntityEditRecord,
      unknown,
      object
    >[],
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
  request: EntityEditRequest<E>,
): Record<string, unknown> {
  const intent = resolved.intentDefinition;
  const defaults =
    typeof intent.defaults === "function"
      ? intent.defaults(resolved.context)
      : (intent.defaults ?? {});
  return {
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
    ...(request.operation === "create" || intent.acceptsSeed === true
      ? request.seed
      : {}),
  };
}

/**
 * Normalize and validate all selected semantic fields, then let the entity
 * intent build its server command. No UI code gets to hand-shape a patch.
 */
export function buildEntityEdit<E extends EditableEntity>(
  resolved: ResolvedEntityEdit<E>,
  request: EntityEditRequest<E>,
  values: Readonly<Record<string, unknown>>,
): EntityEditBuildResult<E> {
  const intent = resolved.intentDefinition;
  const operationAccess = intent.access({
    surface: request.surface,
    record: request.record,
    context: resolved.context,
  });
  if (operationAccess.mode !== "editable") {
    return { ok: false, issues: [denied(operationAccess)] };
  }

  const normalized: Record<string, unknown> = {};
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
    normalized[field.id] = field.normalize(values[field.id]);
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
  if (issues.length > 0) return { ok: false, issues };

  for (const field of resolved.fields) {
    if (!(field.id in normalized)) continue;
    const patch = field.toPatch({
      value: normalized[field.id],
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

export async function executeEntityEdit<E extends EditableEntity>(
  port: EntityMutationPort,
  definition: EntityEditDefinition<E>,
  build: EntityEditBuildResult<E>,
): Promise<EntityEditResult<E>> {
  if (!build.ok) return build;
  if (!build.changed) {
    return {
      ok: true,
      entity: definition.entity,
      id: build.command.id ?? build.command.ids?.[0] ?? "",
      changed: false,
    };
  }
  const execution = await port.execute(build.command);
  await port.invalidate(definition.invalidationKeys);
  port.watchBackgroundWork?.({
    result: execution.result,
    invalidateKeys: definition.invalidationKeys,
  });
  return {
    ok: true,
    entity: definition.entity,
    id: execution.id,
    changed: true,
    result: execution.result,
  };
}

/** Tiny fake adapter for pure kernel tests and consumer contract tests. */
export function createFakeEntityMutationPort(input?: {
  execute?: <E extends EditableEntity>(
    command: EntityEditCommand<E>,
  ) => Promise<{ id: string; result: unknown }>;
}) {
  const commands: EntityEditCommand<EditableEntity>[] = [];
  const invalidations: QueryKey[][] = [];
  const backgroundWork: Array<{
    result: unknown;
    invalidateKeys: readonly QueryKey[];
  }> = [];
  const port: EntityMutationPort = {
    execute: async (command) => {
      commands.push(command);
      return input?.execute
        ? await input.execute(command)
        : {
            id: command.id ?? "created",
            result: { id: command.id ?? "created" },
          };
    },
    invalidate: async (keys) => {
      invalidations.push([...keys]);
    },
    watchBackgroundWork: (entry) => {
      backgroundWork.push(entry);
    },
  };
  return { port, commands, invalidations, backgroundWork };
}
