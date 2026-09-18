import {
  imageIngressRouteById,
  isGalleryEntity,
  shortcodeEntities,
  type ImageIngressBinding,
  type ImageIngressRoute,
} from "@cubby/schemas/entity-manifest";
import { anyShortcodeSchema, parseEntityRef } from "@cubby/schemas/identifiers";
import { z } from "zod";

import type {
  PhotoImportCommitInput,
  PhotoImportReceipt,
} from "~/contracts/photo-import.contract";
import {
  executeEntity,
  type EntityKernelContext,
} from "~/server/entity-kernel";
import { ENTITY_KERNEL_ENTITIES } from "~/server/entity-kernel/contracts";
import { createAppError } from "~/server/errors/app-error";
import { ENTITY_KERNEL_BINDINGS } from "~/server/generated/entity-kernel-bindings.gen";
import {
  attachImportedGalleryImages,
  attachImportedSingularImage,
  importedSingularImageIsOccupied,
  isSingularImageOwner,
  photoImportRelationExists,
  photoImportRelationTraversals,
  type ImportImageRow,
} from "~/server/repo/photo-import";
import { resolveOrThrow } from "~/server/repo/shortcode-resolver";
import {
  isMutationSideEffectRef,
  type MutationSideEffectEvent,
} from "~/server/services/mutation-side-effects";

import type {
  PhotoImportRouteAdapter,
  PhotoImportRouteCommitResult,
} from "./photo-import-commit.service";

type Route = ImageIngressRoute;
type CreateBody = PhotoImportCommitInput["creates"][number]["body"];

const routesByID = new Map<string, Route>(
  Object.values(imageIngressRouteById).map((route) => [route.routeId, route]),
);
const shortcodeEntity = z.enum(shortcodeEntities);
const kernelEntity = z.enum(ENTITY_KERNEL_ENTITIES);
const createBodySchema = z.record(z.string(), z.json());
type SourceContext = PhotoImportCommitInput["images"][number]["source"];
type CapturedAt = PhotoImportCommitInput["creates"][number]["capturedAt"];
type SourceRecord = ReadonlyMap<string, z.output<ReturnType<typeof z.json>>>;

const targetEntityFor = (route: Route) =>
  shortcodeEntity.parse(route.targetEntity);

const sourceEntityFor = (route: Pick<ImageIngressRoute, "sourceEntity">) =>
  shortcodeEntity.parse(route.sourceEntity);

export const assertPhotoImportSourceContext = (
  route: Pick<ImageIngressRoute, "routeId" | "sourceEntity">,
  source: SourceContext,
): void => {
  if (
    source.entity !== route.sourceEntity ||
    !anyShortcodeSchema([sourceEntityFor(route)]).safeParse(source.id).success
  ) {
    throw createAppError(
      "CONSTRAINT_VIOLATION",
      `Source ${source.entity}:${source.id} does not match route ${route.routeId}`,
    );
  }
};

export const assertPhotoImportReplacementAllowed = (
  route: Pick<ImageIngressRoute, "routeId" | "requiresReplaceConfirmation">,
  occupied: boolean,
  replaceConfirmed: boolean,
): void => {
  if (route.requiresReplaceConfirmation && occupied && !replaceConfirmed) {
    throw createAppError(
      "CONSTRAINT_VIOLATION",
      `Route ${route.routeId} requires explicit replacement confirmation`,
    );
  }
};

const sourceFieldValue = (
  sourceRecord: SourceRecord,
  field: string,
): z.output<ReturnType<typeof z.json>> => {
  if (!sourceRecord.has(field)) {
    throw createAppError(
      "CONSTRAINT_VIOLATION",
      `Photo route source is missing bound field ${field}`,
    );
  }
  return sourceRecord.get(field) ?? null;
};

const relationItemValue = (
  binding: Extract<ImageIngressBinding, { from: "relation-items" }>,
  source: SourceContext,
  sourceRecord: SourceRecord,
) => {
  switch (binding.item.from) {
    case "source-id":
      return source.id;
    case "source-field":
      if (!binding.item.sourceField) {
        throw createAppError(
          "CONSTRAINT_VIOLATION",
          `Photo route binding ${binding.field} is missing sourceField`,
        );
      }
      return sourceFieldValue(sourceRecord, binding.item.sourceField);
    case "constant":
      return binding.item.value ?? null;
  }
};

/** Apply compiler-validated bindings over the user's staged editor draft. */
export const materializePhotoImportCreateBody = (
  route: Pick<ImageIngressRoute, "bindings">,
  body: CreateBody,
  source: SourceContext,
  capturedAt: CapturedAt,
  sourceRecord: SourceRecord,
): CreateBody => {
  const materialized = createBodySchema.parse(body);
  for (const binding of route.bindings) {
    switch (binding.from) {
      case "source-id":
        materialized[binding.field] = source.id;
        break;
      case "source-field":
        materialized[binding.field] = sourceFieldValue(
          sourceRecord,
          binding.sourceField,
        );
        break;
      case "capture-date":
        if (capturedAt) {
          materialized[binding.field] = capturedAt.slice(0, 10);
        }
        break;
      case "constant":
        materialized[binding.field] = binding.value;
        break;
      case "relation-items":
        materialized[binding.field] = [
          {
            [binding.item.field]: relationItemValue(
              binding,
              source,
              sourceRecord,
            ),
          },
        ];
        break;
    }
  }
  return materialized;
};

const routeFor = (routeId: string): Route => {
  const route = routesByID.get(routeId);
  if (!route) {
    throw createAppError(
      "CONSTRAINT_VIOLATION",
      `Unknown manifest photo route: ${routeId}`,
    );
  }
  return route;
};

const validateDestinationCode = (route: Route, code: string): void => {
  const target = targetEntityFor(route);
  if (!anyShortcodeSchema([target]).safeParse(code).success) {
    throw createAppError(
      "CONSTRAINT_VIOLATION",
      `Destination ${code} does not match route ${route.routeId}`,
    );
  }
};

interface RuntimeCreateBinding {
  sideEffects: boolean;
  schemas: { createInput: z.ZodType | null };
  repository: {
    create?: (
      context: EntityKernelContext,
      input: CreateBody,
    ) => Promise<{ entityId: string; output: unknown }>;
  };
}

const runtimeCreateBindings = new Map<string, RuntimeCreateBinding>(
  Object.entries(ENTITY_KERNEL_BINDINGS).map(([entity, binding]) => {
    // SAFETY: the generator checks every value against EntityKernelCoreBinding;
    // this erases only the entity-correlated create input after it is parsed by
    // that same binding's create schema below.
    const erasedBinding = binding as RuntimeCreateBinding;
    return [entity, erasedBinding];
  }),
);

const runtimeCreateBinding = (
  entity: Route["targetEntity"],
): RuntimeCreateBinding => {
  const binding = runtimeCreateBindings.get(entity);
  if (!binding) {
    throw createAppError(
      "CONSTRAINT_VIOLATION",
      `Manifest route target ${entity} cannot be created by the entity kernel`,
    );
  }
  return binding;
};

const routeNeedsSourceRecord = (route: Route): boolean =>
  route.bindings.some(
    (binding) =>
      binding.from === "source-field" ||
      (binding.from === "relation-items" &&
        binding.item.from === "source-field"),
  );

const readSourceRecord = async (
  context: EntityKernelContext,
  route: Route,
  source: SourceContext,
): Promise<SourceRecord> => {
  if (!routeNeedsSourceRecord(route)) return new Map();
  const entity = kernelEntity.safeParse(route.sourceEntity);
  if (!entity.success) {
    throw createAppError(
      "CONSTRAINT_VIOLATION",
      `Route ${route.routeId} cannot read its source fields`,
    );
  }
  const result = await executeEntity(context, {
    action: "get",
    entity: entity.data,
    id: source.id,
    missing: "error",
  });
  if (result.action !== "get" || result.item === null) {
    throw createAppError(
      "REFERENCED_RECORD_MISSING",
      `Photo route source ${source.id} is unavailable`,
    );
  }
  return new Map(Object.entries(createBodySchema.parse(result.item)));
};

const createDestination = async (
  context: EntityKernelContext,
  route: Route,
  body: CreateBody,
): Promise<{ id: string; event: MutationSideEffectEvent | null }> => {
  const binding = runtimeCreateBinding(route.targetEntity);
  if (!binding.schemas.createInput || !binding.repository.create) {
    throw createAppError(
      "CONSTRAINT_VIOLATION",
      `Route ${route.routeId} targets a destination that cannot be created`,
    );
  }
  const result = await binding.repository.create(
    context,
    createBodySchema.parse(binding.schemas.createInput.parse(body)),
  );
  const id = z.object({ id: z.string() }).parse(result.output).id;
  const ref = parseEntityRef(targetEntityFor(route), result.entityId);
  const event =
    binding.sideEffects && isMutationSideEffectRef(ref)
      ? ({
          action: "created",
          entity: ref,
          source: "photoImport.commit",
        } satisfies MutationSideEffectEvent)
      : null;
  return { id, event };
};

const bindingItemForDraft = (
  input: PhotoImportCommitInput,
  draftId: string,
): PhotoImportCommitInput["images"][number] => {
  const items = input.images.filter(
    (item) =>
      item.destination.kind === "create" &&
      item.destination.draftId === draftId,
  );
  const first = items[0];
  if (!first) {
    throw createAppError(
      "CONSTRAINT_VIOLATION",
      `Photo import draft ${draftId} is unused`,
    );
  }
  if (
    items.some(
      (item) =>
        item.source.entity !== first.source.entity ||
        item.source.id !== first.source.id,
    )
  ) {
    throw createAppError(
      "CONSTRAINT_VIOLATION",
      `Photo import draft ${draftId} has conflicting binding sources`,
    );
  }
  return first;
};

const materializedDraftBody = async (
  context: EntityKernelContext,
  route: Route,
  item: PhotoImportCommitInput["images"][number],
  draft: PhotoImportCommitInput["creates"][number],
): Promise<CreateBody> =>
  materializePhotoImportCreateBody(
    route,
    draft.body,
    item.source,
    draft.capturedAt,
    await readSourceRecord(context, route, item.source),
  );

const validateExistingDestination = async (
  context: EntityKernelContext,
  route: Route,
  item: PhotoImportCommitInput["images"][number],
  sourceId: string,
): Promise<void> => {
  if (item.destination.kind !== "existing") {
    throw createAppError(
      "CONSTRAINT_VIOLATION",
      `Route ${route.routeId} requires an existing destination`,
    );
  }
  validateDestinationCode(route, item.destination.candidateId);
  const destinationId = await resolveOrThrow(
    context.db,
    targetEntityFor(route),
    item.destination.candidateId,
  );
  if (route.kind === "self") {
    if (
      route.sourceEntity !== route.targetEntity ||
      String(sourceId) !== String(destinationId)
    ) {
      throw createAppError(
        "CONSTRAINT_VIOLATION",
        `Route ${route.routeId} must attach to its source record`,
      );
    }
  } else if (
    !(await photoImportRelationExists(
      context.db,
      route.sourceEntity,
      item.source.id,
      route.relationPath,
      route.targetEntity,
      item.destination.candidateId,
    ))
  ) {
    throw createAppError(
      "CONSTRAINT_VIOLATION",
      `Destination ${item.destination.candidateId} is not related to source ${item.source.id}`,
    );
  }
  if (isSingularImageOwner(route.targetEntity)) {
    assertPhotoImportReplacementAllowed(
      route,
      await importedSingularImageIsOccupied(
        context.db,
        route.targetEntity,
        item.destination.candidateId,
      ),
      item.replaceConfirmed,
    );
  }
};

const validatePlan = async (
  context: EntityKernelContext,
  input: PhotoImportCommitInput,
): Promise<void> => {
  const creates = new Map(input.creates.map((draft) => [draft.draftId, draft]));
  if (creates.size !== input.creates.length) {
    throw createAppError(
      "CONSTRAINT_VIOLATION",
      "Photo import draft identifiers must be unique",
    );
  }
  const usedDrafts = new Set<string>();
  const singularDestinations = new Map<string, string>();
  for (const item of input.images) {
    const route = routeFor(item.routeId);
    assertPhotoImportSourceContext(route, item.source);
    const sourceId = await resolveOrThrow(
      context.db,
      sourceEntityFor(route),
      item.source.id,
    );
    if (route.kind === "createRelated") {
      if (item.destination.kind !== "create") {
        throw createAppError(
          "CONSTRAINT_VIOLATION",
          `Route ${route.routeId} requires a staged destination`,
        );
      }
      const draft = creates.get(item.destination.draftId);
      if (!draft || draft.routeId !== route.routeId) {
        throw createAppError(
          "CONSTRAINT_VIOLATION",
          `Draft ${item.destination.draftId} does not match route ${route.routeId}`,
        );
      }
      const traversals = photoImportRelationTraversals(
        route.sourceEntity,
        route.relationPath,
      );
      if (
        !traversals.some(
          (traversal) => traversal.targetEntity === route.targetEntity,
        )
      ) {
        throw createAppError(
          "CONSTRAINT_VIOLATION",
          `Route ${route.routeId} does not reach its declared target`,
        );
      }
      usedDrafts.add(draft.draftId);
    } else {
      await validateExistingDestination(context, route, item, sourceId);
    }
    if (route.storage !== "gallery") {
      const destinationKey =
        item.destination.kind === "existing"
          ? item.destination.candidateId
          : item.destination.draftId;
      const key = `${route.routeId}:${destinationKey}`;
      const assignedImage = singularDestinations.get(key);
      if (assignedImage !== undefined && assignedImage !== item.imageId) {
        throw createAppError(
          "CONSTRAINT_VIOLATION",
          `Route ${route.routeId} accepts only one image per destination`,
        );
      }
      singularDestinations.set(key, item.imageId);
    }
  }
  if (usedDrafts.size !== creates.size) {
    throw createAppError(
      "CONSTRAINT_VIOLATION",
      "Photo import contains an unused staged destination",
    );
  }
  for (const draft of input.creates) {
    const route = routeFor(draft.routeId);
    const item = bindingItemForDraft(input, draft.draftId);
    const binding = runtimeCreateBinding(route.targetEntity);
    if (!binding.schemas.createInput || !binding.repository.create) {
      throw createAppError(
        "CONSTRAINT_VIOLATION",
        `Route ${route.routeId} cannot create its destination`,
      );
    }
    binding.schemas.createInput.parse(
      await materializedDraftBody(context, route, item, draft),
    );
  }
};

const sideEffectForExistingDestination = async (
  context: EntityKernelContext,
  route: Route,
  code: string,
): Promise<MutationSideEffectEvent | null> => {
  const target = targetEntityFor(route);
  const id = await resolveOrThrow(context.db, target, code);
  const ref = parseEntityRef(target, id);
  return isMutationSideEffectRef(ref)
    ? {
        action: "updated",
        entity: ref,
        source: "photoImport.commit",
        locationImagesChanged: route.targetEntity === "location" || undefined,
      }
    : null;
};

const applyPlan = async (
  context: EntityKernelContext,
  input: PhotoImportCommitInput,
): Promise<PhotoImportRouteCommitResult> => {
  const destinations = new Map<string, string>();
  const createdDestinations: PhotoImportReceipt["createdDestinations"] = [];
  const events: MutationSideEffectEvent[] = [];
  for (const draft of input.creates) {
    const route = routeFor(draft.routeId);
    const item = bindingItemForDraft(input, draft.draftId);
    const created = await createDestination(
      context,
      route,
      await materializedDraftBody(context, route, item, draft),
    );
    if (
      !(await photoImportRelationExists(
        context.db,
        route.sourceEntity,
        item.source.id,
        route.relationPath,
        route.targetEntity,
        created.id,
      ))
    ) {
      throw createAppError(
        "CONSTRAINT_VIOLATION",
        `Created destination ${created.id} does not satisfy route ${route.routeId}`,
      );
    }
    destinations.set(draft.draftId, created.id);
    createdDestinations.push({
      draftId: draft.draftId,
      routeId: draft.routeId,
      id: created.id,
    });
    if (created.event) events.push(created.event);
  }

  const galleryGroups = new Map<
    string,
    { route: Route; destination: string; imageCodes: string[] }
  >();
  const appliedAssociations = new Set<string>();
  for (const item of input.images) {
    const route = routeFor(item.routeId);
    const destination =
      item.destination.kind === "existing"
        ? item.destination.candidateId
        : destinations.get(item.destination.draftId);
    if (!destination) throw new Error("Validated destination was not created");
    const associationKey = `${route.targetEntity}:${destination}:${item.imageId}`;
    if (appliedAssociations.has(associationKey)) continue;
    appliedAssociations.add(associationKey);
    if (route.storage === "gallery") {
      if (!isGalleryEntity(route.targetEntity)) {
        throw createAppError(
          "CONSTRAINT_VIOLATION",
          `Route ${route.routeId} has an invalid gallery target`,
        );
      }
      const key = `${route.targetEntity}:${destination}`;
      const group = galleryGroups.get(key);
      if (group && !group.imageCodes.includes(item.imageId)) {
        group.imageCodes.push(item.imageId);
      } else
        galleryGroups.set(key, {
          route,
          destination,
          imageCodes: [item.imageId],
        });
    } else {
      if (!isSingularImageOwner(route.targetEntity)) {
        throw createAppError(
          "CONSTRAINT_VIOLATION",
          `Route ${route.routeId} has an invalid singular-image target`,
        );
      }
      await attachImportedSingularImage(
        context.db,
        route.targetEntity,
        destination,
        item.imageId,
        item.replaceConfirmed,
      );
    }
    if (item.destination.kind === "existing") {
      const event = await sideEffectForExistingDestination(
        context,
        route,
        destination,
      );
      if (event) events.push(event);
    }
  }
  for (const group of galleryGroups.values()) {
    if (!isGalleryEntity(group.route.targetEntity)) {
      throw new Error("Validated gallery route changed during commit");
    }
    await attachImportedGalleryImages(
      context.db,
      group.route.targetEntity,
      group.destination,
      group.imageCodes,
    );
  }
  const uniqueEvents = [
    ...new Map(
      events.map((event) => [
        `${event.action}:${event.entity.entity}:${event.entity.id}`,
        event,
      ]),
    ).values(),
  ];
  return { createdDestinations, sideEffectEvents: uniqueEvents };
};

export const manifestPhotoImportRouteAdapter: PhotoImportRouteAdapter = {
  validate: (
    context,
    input,
    _imagesByCode: ReadonlyMap<string, ImportImageRow>,
  ) => validatePlan(context, input),
  apply: (context, input, _imagesByCode: ReadonlyMap<string, ImportImageRow>) =>
    applyPlan(context, input),
};
