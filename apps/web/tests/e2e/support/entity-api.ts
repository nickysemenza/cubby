import type { APIRequestContext } from "@playwright/test";
import type { z } from "zod";

import type { entityKernelObject } from "~/contracts/entity-kernel-wire";

type RequestOptions = Parameters<APIRequestContext["post"]>[1];
/** The kernel's loose wire body; the server parses it with the entity's schema. */
type KernelInput = z.input<typeof entityKernelObject>;

const requestOrigins = new WeakMap<APIRequestContext, Promise<string>>();

/** Uses the same authenticated request context as the browser fixtures. */
export function entityApi(request: APIRequestContext) {
  const post = async (
    operation: string,
    data: unknown,
    options?: RequestOptions,
  ) => {
    let headers = options?.headers;
    if (headers === undefined) {
      let origin = requestOrigins.get(request);
      if (!origin) {
        origin = request
          .get("/api/auth/get-session")
          .then((response) => new URL(response.url()).origin);
        requestOrigins.set(request, origin);
      }
      headers = { Origin: await origin };
    }
    const response = await request.post(`/api/v1/entity/${operation}`, {
      ...options,
      headers,
      data,
    });
    return Object.assign(response, {
      parsedBody: (await response.json()) as unknown,
    });
  };
  return {
    get: (entity: string, shortcode: string, options?: RequestOptions) =>
      post("detail", { entity, shortcode }, options),
    list: (entity: string, input: KernelInput = {}, options?: RequestOptions) =>
      post("list", { filters: {}, ...input, entity }, options),
    create: (entity: string, data: unknown, options?: RequestOptions) =>
      post("mutate", { action: "create", entity, data }, options),
    update: (
      entity: string,
      id: string,
      data: unknown,
      options?: RequestOptions,
    ) => post("mutate", { action: "update", entity, id, data }, options),
    remove: (entity: string, id: string, options?: RequestOptions) =>
      post("mutate", { action: "delete", entity, ids: [id] }, options),
    timeline: (
      entity: string,
      input: KernelInput = {},
      options?: RequestOptions,
    ) =>
      post(
        "timeline",
        { filters: {}, window: {}, pagination: {}, ...input, entity },
        options,
      ),
  };
}
