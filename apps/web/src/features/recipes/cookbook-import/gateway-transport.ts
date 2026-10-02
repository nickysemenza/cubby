import type { HttpRequest, HttpResponse } from "@cubby/recipebridge";
import type { gatewayForwardInput } from "@cubby/schemas/import-recipe";
import type { z } from "zod";

import { withRetry } from "./import-helpers";

/**
 * The `recipe.forwardGatewayRequest` mutation, as this module needs it: a
 * signed pass-through of one request the Rust driver built. Taking it as a
 * parameter keeps the transport testable without a React tree.
 */
export type ForwardGatewayRequest = (
  input: z.input<typeof gatewayForwardInput>,
) => Promise<{
  status: number;
  headers: [string, string][];
  body: string;
}>;

/**
 * Build the `send` callback `Book.extract` drives.
 *
 * The division of labour is deliberate and worth stating, because it is the
 * one place a well-meant improvement would break the extraction ladder:
 *
 * - The BROWSER owns transport only. It hands the request to the server (which
 *   adds the gateway credentials) and hands the response back verbatim.
 * - RUST owns policy. An HTTP response of *any* status — 429, 500, a provider's
 *   own error envelope — is data the ladder reacts to: retry this model, step
 *   down a tier, mark it exhausted, escalate the whole book. Retrying a 429 here
 *   would spend the attempt budget twice and hide the signal that decides it.
 * - So only a *thrown* error is retried, and a thrown error means the request
 *   never produced a response (the fetch failed, the worker was unreachable).
 *   `forwardGatewayRequest` is written to the same rule: it returns non-2xx
 *   as-is and throws only on a transport failure.
 */
export const createGatewaySend =
  (forward: ForwardGatewayRequest) =>
  async (request: HttpRequest): Promise<HttpResponse> => {
    const response = await withRetry(() =>
      forward({
        path: request.path,
        // Copy out of the wasm-owned arrays: the request object is only valid
        // for the duration of the call, and zod will walk these again.
        headers: request.headers.map(([name, value]) => [name, value]),
        // SAFETY: `HttpRequest.body` is a `serde_json::Value` that wasm-bindgen
        // hands over as `unknown`. It is JSON by construction, and the
        // mutation's zod input re-validates it before anything is sent.
        body: request.body as z.input<typeof gatewayForwardInput>["body"],
      }),
    );
    return {
      status: response.status,
      headers: response.headers.map(([name, value]) => [name, value]),
      body: response.body,
    };
  };
