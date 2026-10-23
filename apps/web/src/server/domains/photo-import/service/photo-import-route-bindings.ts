import type {
  ImageIngressBinding,
  ImageIngressRoute,
} from "@cubby/schemas/entity-manifest";
import { anyShortcodeSchema } from "@cubby/schemas/identifiers";
import type { z } from "zod";

import {
  photoImportContract,
  type PhotoImportCommitInput,
} from "~/contracts/photo-import.contract";
import { createAppError } from "~/server/errors/app-error";

export type CreateBody = PhotoImportCommitInput["creates"][number]["body"];
export type SourceContext = PhotoImportCommitInput["images"][number]["source"];
export type SourceRecord = ReadonlyMap<
  string,
  z.output<ReturnType<typeof z.json>>
>;
type CapturedAt = PhotoImportCommitInput["creates"][number]["capturedAt"];
const createBodySchema =
  photoImportContract.ops.commit.input.shape.creates.element.shape.body;

export const sourceEntityFor = (
  route: Pick<ImageIngressRoute, "sourceEntity">,
): NonNullable<SourceContext>["entity"] =>
  photoImportContract.ops.commit.input.shape.images.element.shape.source
    .unwrap()
    .shape.entity.parse(route.sourceEntity);

export const assertPhotoImportSourceContext = (
  route: Pick<ImageIngressRoute, "routeId" | "sourceEntity">,
  source: NonNullable<SourceContext>,
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

/** A `createSelf` route has no source record — it is the only kind `images[].source` must be
 * omitted for; every other kind requires one. */
export const assertPhotoImportSourceCardinality = (
  route: Pick<ImageIngressRoute, "routeId" | "kind">,
  source: SourceContext,
): void => {
  const requiresSource = route.kind !== "createSelf";
  if (requiresSource && source === undefined) {
    throw createAppError(
      "CONSTRAINT_VIOLATION",
      `Route ${route.routeId} requires a source`,
    );
  }
  if (!requiresSource && source !== undefined) {
    throw createAppError(
      "CONSTRAINT_VIOLATION",
      `Route ${route.routeId} is a createSelf route and must not include a source`,
    );
  }
};

/** Refuse a route the manifest declares disabled — the "New <entity>…" affordance stays
 * visible in the client (`disabledReason` captions it), but never resolves to a commit. */
export const assertPhotoImportRouteEnabled = (
  route: Pick<ImageIngressRoute, "routeId" | "enabled" | "disabledReason">,
): void => {
  if (!route.enabled) {
    throw createAppError(
      "CONSTRAINT_VIOLATION",
      `Route ${route.routeId} is disabled: ${route.disabledReason}`,
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
): z.output<ReturnType<typeof z.json>> | undefined => {
  // A missing source field stays editable in the local draft. Do not replace it with
  // an explicit null at commit time; the create schema can then report the real missing
  // required field and the user can correct it in the editor.
  return sourceRecord.get(field);
};

const relationItemValue = (
  binding: Extract<ImageIngressBinding, { from: "relation-items" }>,
  source: SourceContext,
  sourceRecord: SourceRecord,
) => {
  switch (binding.item.from) {
    case "source-id":
      // The compiler forbids `relation-items` on a `createSelf` route (it has no
      // source), so this only runs when `source` is present.
      if (source === undefined) {
        throw createAppError(
          "CONSTRAINT_VIOLATION",
          `Photo route binding ${binding.field} requires a source`,
        );
      }
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
        // The compiler forbids `source-id` on a `createSelf` route (it has no
        // source), so this only runs when `source` is present.
        if (source === undefined) {
          throw createAppError(
            "CONSTRAINT_VIOLATION",
            `Photo route binding ${binding.field} requires a source`,
          );
        }
        materialized[binding.field] = source.id;
        break;
      case "source-field":
        const sourceValue = sourceFieldValue(sourceRecord, binding.sourceField);
        if (sourceValue !== undefined && sourceValue !== null) {
          materialized[binding.field] = sourceValue;
        }
        break;
      case "capture-date":
        if (
          capturedAt &&
          (materialized[binding.field] === undefined ||
            materialized[binding.field] === null)
        ) {
          materialized[binding.field] = capturedAt.slice(0, 10);
        }
        break;
      case "constant":
        materialized[binding.field] = binding.value;
        break;
      case "relation-items":
        const value = relationItemValue(binding, source, sourceRecord);
        if (
          value !== undefined &&
          !(binding.item.from === "source-field" && value === null)
        ) {
          materialized[binding.field] = [{ [binding.item.field]: value }];
        }
        break;
    }
  }
  return materialized;
};
