import { EntityDeclarationError } from "../declarations.ts";
import type { CompiledEntity } from "../declarations.ts";
import { kernelEntitiesFor } from "./shared.ts";
import {
  hasGenericListOperation,
  servesKernelGet,
} from "../list-capabilities.ts";

type ContractEntity = CompiledEntity & {
  contract: NonNullable<CompiledEntity["contract"]>;
};

type EntityProjectionMaps = Readonly<{
  schema: readonly ContractEntity[];
  detail: readonly ContractEntity[];
  list: readonly ContractEntity[];
  /** List-roster entities with browser create or update actions. */
  crud: readonly ContractEntity[];
  filters: readonly CompiledEntity[];
  routes: readonly CompiledEntity[];
}>;

/** A tree row's `childCount`, present in the `roots`/`children` scopes. */
export const treeRowExtension = (inspector: {
  list: { tree: unknown };
}): string =>
  inspector.list.tree === null
    ? ""
    : ".extend({childCount:listChildCountSchema})";

/** Shared surface selection keeps all generated entity rosters correlated. */
export const entityProjectionMaps = (
  entities: readonly CompiledEntity[],
): EntityProjectionMaps => {
  const schema = entities.filter(
    (entity): entity is ContractEntity => entity.contract !== null,
  );
  // The generic detail page reads the kernel `get`, which every kernel entity
  // serves whether or not it accepts writes.
  const detail = schema.filter(servesKernelGet);
  const list = schema.filter(hasGenericListOperation);
  const crud = list.filter(
    ({ contract, fieldModel }) =>
      fieldModel.intents !== null &&
      (contract.create !== null || contract.update !== null),
  );
  return {
    schema,
    detail,
    list,
    crud,
    filters: entities,
    routes: entities.filter(
      ({ descriptor }) => descriptor.browserRoutes !== false,
    ),
  };
};

type KernelHttpAction =
  | "list"
  | "timeline"
  | "get"
  | "create"
  | "update"
  | "bulkUpdate"
  | "delete";
export type KernelActions = Readonly<
  Record<string, readonly KernelHttpAction[]>
>;

/**
 * The entity-kernel actions the HTTP API serves per entity, as data: the
 * native client's capability table (`entity-kernel.json`) and the web
 * inspector's native coverage are derived from it in the native contract stage.
 */
export const kernelHttpActionsFor = (
  entities: readonly CompiledEntity[],
): KernelActions => {
  const projections = entityProjectionMaps(entities);
  return Object.fromEntries(
    kernelEntitiesFor(entities).flatMap((entity) => {
      if (!entity.route || !entity.contract) return [];
      const executable = kernelActionsFor(entity);
      const verbs: KernelHttpAction[] = [];
      const listed = projections.list.some(
        (candidate) => candidate.key === entity.key,
      );
      if (listed) verbs.push("list");
      if (entity.timeline !== null) {
        if (!listed)
          throw new EntityDeclarationError(
            `${entity.key}.capabilities.timeline needs a generated list (the timeline reads the list filters).`,
          );
        verbs.push("timeline");
      }
      if (projections.detail.some((candidate) => candidate.key === entity.key))
        verbs.push("get");
      for (const action of [
        "create",
        "update",
        "bulkUpdate",
        "delete",
      ] as const)
        if (executable.includes(action)) verbs.push(action);
      return [[entity.key, verbs]];
    }),
  );
};

/** Entity key -> output schema export name, for the native contract stage's Swift aliases. */
export const entityOutputsFor = (
  entities: readonly CompiledEntity[],
): ReadonlyMap<string, string | null> =>
  new Map(
    entities.map(({ key, contract }) => [key, contract?.output.export ?? null]),
  );

export const kernelActionsFor = (entity: CompiledEntity) => {
  const lifecycle = entity.lifecycle;
  const reads = [
    "get",
    "list",
    ...(entity.descriptor.searchable === true ? ["search"] : []),
  ];
  const resolve = entity.resolve === null ? [] : ["resolve"];
  // A read-only entity keeps its other writes in its own workflows; the
  // kernel serves its reads and nothing else.
  if (lifecycle.readOnly) return [...reads, ...resolve];
  return [
    ...reads,
    ...(entity.contract?.create ? ["create"] : []),
    ...(entity.contract?.update ? ["update"] : []),
    ...(entity.bulkUpdateFields === null ? [] : ["bulkUpdate"]),
    ...(entity.operationOwners.delete === "kernel" ? ["delete"] : []),
    ...(entity.operationOwners.merge === "kernel" ? ["merge"] : []),
    ...resolve,
  ];
};
