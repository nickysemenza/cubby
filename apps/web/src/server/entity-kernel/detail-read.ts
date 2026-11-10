import {
  ENTITY_LABEL,
  ENTITY_NOT_FOUND_REASON,
} from "@cubby/schemas/identifiers";
import { z } from "zod";

import { withUniversalEntityMedia } from "~/server/entity-kernel/repo/entity-display-image";
import {
  describeUnresolvableCode,
  isShortcodeEntity,
} from "~/server/entity-kernel/repo/entity-identity";
import { createAppError } from "~/server/errors/app-error";
import { publicFieldEnvelopeRows } from "~/server/generic/derived/repo/public-read";
import { detailBreadcrumb } from "~/server/generic/entity-detail/repo/detail-breadcrumb";
import { workflow } from "~/server/workflows/runtime/builder";
import { bindWorkflow } from "~/server/workflows/runtime/operation";

import type {
  EntityBindingSchemas,
  EntityKernelContext,
  EntityKernelReadBinding,
} from "./adapter";
import type { EntityKernelEntity } from "./contracts";
import { parseSchema } from "./list-input";

/** Complete commands and lazy detail reads share every get stage and validator. */
export function defineEntityGet<
  const E extends EntityKernelEntity,
  const S extends EntityBindingSchemas,
>(
  binding: Pick<
    EntityKernelReadBinding<E, S>,
    "entity" | "schemas" | "repository"
  >,
) {
  const resultSchema = z.object({
    action: z.literal("get"),
    entity: z.literal(binding.entity),
    item: z.nullable<S["detail"]>(binding.schemas.detail),
  });
  return bindWorkflow(
    workflow<EntityKernelContext, { id: string; missing: "error" | "null" }>(
      `${binding.entity}.get`,
    )
      .call("id", async (_, { input }) =>
        parseSchema<S["id"], string>(binding.schemas.id, input.id),
      )
      .call("found", async ({ context }, { input, id }) => {
        // A merged-away or deleted code is simply not found; the message
        // names the survivor (ADR 0006).
        const page = await binding.repository.read(context, [id]);
        const [row] = page.data;
        return {
          item:
            row === undefined
              ? null
              : binding.schemas.repositoryDetail.parse(row),
          fieldReads: page.fieldReads,
          missingMessage:
            row === undefined && isShortcodeEntity(binding.entity)
              ? await describeUnresolvableCode(
                  context.db,
                  binding.entity,
                  input.id,
                )
              : null,
        };
      })
      .call("media", async ({ context }, { found }) => {
        // The parsed detail schema is typed loosely; a found record is an object.
        const record = found.item;
        if (record === null || record === undefined) return null;
        // The breadcrumb reads reference and placement fields, which media
        // never changes, so both start together and share round trips.
        const [[item], breadcrumb] = await Promise.all([
          withUniversalEntityMedia(context.db, binding.entity, [record], true),
          detailBreadcrumb(context.db, binding.entity, record),
        ]);
        return {
          ...item,
          ...(breadcrumb === undefined ? {} : { breadcrumb }),
        };
      })
      .call("enveloped", async ({ context }, { found, media }) =>
        media === null
          ? null
          : (
              await publicFieldEnvelopeRows({
                db: context.db,
                entity: binding.entity,
                schema: binding.schemas.detail,
                rows: [media],
                contexts: found.fieldReads,
              })
            )[0],
      )
      .output(({ input, found, media, enveloped }) => {
        if (media === null && input.missing !== "null")
          throw createAppError(
            ENTITY_NOT_FOUND_REASON[binding.entity],
            found.missingMessage ??
              `${ENTITY_LABEL[binding.entity]} ${input.id} not found`,
          );
        return resultSchema.parse({
          action: "get",
          entity: binding.entity,
          item: enveloped ?? null,
        });
      }),
  );
}
