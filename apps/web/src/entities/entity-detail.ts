import type { PublicImpactItem } from "@cubby/schemas/entity-integrity";
import { queryOptions } from "@tanstack/react-query";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";
import type {
  EntityDetailByEntity,
  EntityDetailInputByEntity,
} from "./generated/entity-details.gen";
import {
  type DetailEntity,
  detailEntities,
} from "./generated/entity-details.gen";

const detailTransportInput = z.object({
  entity: z.enum(detailEntities),
  shortcode: z.string().min(1),
});

type PublicDetailError = {
  message: string;
  code?: string;
  reason?: string;
  blockers?: PublicImpactItem[];
};

type DetailTransportResult =
  | { ok: true; item: EntityDetailByEntity[DetailEntity] | null }
  | { ok: false; error: PublicDetailError };

const getEntityDetailTransport = createServerFn({ method: "GET" })
  .validator(detailTransportInput)
  .handler(async ({ data }): Promise<DetailTransportResult> => {
    const [contextModule, kernelModule, bindingModule, errorModule] =
      await Promise.all([
        import("~/server/request-context"),
        import("~/server/entity-kernel"),
        import("~/server/generated/entity-bindings.gen"),
        import("~/server/errors/app-error"),
      ]);

    try {
      const input = bindingModule.entityDetailInputSchema.parse(data);
      const context = contextModule.requireActor(
        await contextModule.createRequestContext({
          headers: getRequest().headers,
        }),
      );
      const result = await kernelModule.executeEntity(context, {
        action: "get",
        entity: input.entity,
        id: input.shortcode,
        missing: "null",
      });
      if (result.action !== "get") {
        throw new Error("Entity kernel returned the wrong action");
      }
      const item =
        result.item === null
          ? null
          : bindingModule.ENTITY_DETAIL_OUTPUT_SCHEMAS[input.entity].parse(
              result.item,
            );
      return {
        ok: true,
        item: item as EntityDetailByEntity[DetailEntity] | null,
      };
    } catch (error) {
      if (error instanceof z.ZodError) {
        return {
          ok: false,
          error: {
            code: "BAD_REQUEST",
            reason: "INVALID_INPUT",
            message: error.issues.map((issue) => issue.message).join(", "),
          },
        };
      }
      const payload = errorModule.toPublicErrorPayload(error);
      if (payload.code || payload.reason || payload.blockers) {
        return {
          ok: false,
          error: {
            message: error instanceof Error ? error.message : String(error),
            ...payload,
          },
        };
      }
      throw error;
    }
  });

export class EntityDetailError extends Error {
  readonly data: Omit<PublicDetailError, "message">;

  constructor(error: PublicDetailError) {
    super(error.message);
    this.name = "EntityDetailError";
    this.data = {
      ...(error.code ? { code: error.code } : {}),
      ...(error.reason ? { reason: error.reason } : {}),
      ...(error.blockers ? { blockers: error.blockers } : {}),
    };
  }
}

async function getEntityDetail<E extends DetailEntity>(options: {
  data: EntityDetailInputByEntity[E];
  signal?: AbortSignal;
}): Promise<EntityDetailByEntity[E] | null> {
  const result = await getEntityDetailTransport(options);
  if (!result.ok) throw new EntityDetailError(result.error);
  return result.item as EntityDetailByEntity[E] | null;
}

export const entityDetailQueryKey = <E extends DetailEntity>(
  entity: E,
  shortcode: string,
) => [[entity, "detail"], { shortcode }] as const;

export const entityDetailRootKey = <E extends DetailEntity>(entity: E) =>
  [[entity, "detail"]] as const;

export function entityDetailQueryOptions<E extends DetailEntity>(
  entity: E,
  shortcode: EntityDetailInputByEntity[E]["shortcode"],
  options?: { enabled?: boolean },
) {
  return queryOptions({
    queryKey: entityDetailQueryKey(entity, shortcode),
    queryFn: ({ signal }) =>
      getEntityDetail({
        data: { entity, shortcode } as EntityDetailInputByEntity[E],
        signal,
      }),
    ...options,
  });
}
