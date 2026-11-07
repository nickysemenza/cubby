import {
  isInferenceFundingRefusal,
  isPaidFundingUnavailable,
  type GatewayControls,
  type GatewayFetchRequest,
} from "@cubby/shared/ai/gateway-request";
import type { GatewayProvider } from "@cubby/shared/ai/models";
import { sleep } from "@cubby/shared/retry";

import { findErrorCause } from "~/lib/error-diagnostics";
import type { UnparsedError } from "~/lib/error-utils";

import { deferCooperativeAiWork } from "./cooperative-work";
import type { AiGatewayEgressRpc } from "./gateway-egress-contract";

export class GatewayAdmissionWaitError extends Error {
  constructor(readonly retryAt: number) {
    super("AI Gateway admission is waiting for shared capacity");
  }
}
export const gatewayAdmissionWait = (error: UnparsedError) =>
  findErrorCause(
    error,
    (cause): cause is GatewayAdmissionWaitError =>
      cause instanceof GatewayAdmissionWaitError,
  );

export const isGatewayAdmissionWait = (error: UnparsedError) =>
  gatewayAdmissionWait(error) !== undefined;

/** The provider needs funding or configuration; probe later without exhausting targets. */
export class GatewayProviderStopError extends Error {
  readonly retryAt = Date.now() + 15 * 60_000;

  constructor(
    readonly kind: "funding" | "configuration",
    readonly status: number,
    body: string,
  ) {
    super(`Decision request failed (${status}): ${body}`);
  }
}

/** Classify the actual provider response once, before retrying or wrapping it. */
export function gatewayProviderStop(status: number, body: string) {
  if (
    status === 402 ||
    isPaidFundingUnavailable(body) ||
    isInferenceFundingRefusal(status, body, "openai_credit") ||
    isInferenceFundingRefusal(status, body, "subscriber_credit")
  )
    return new GatewayProviderStopError("funding", status, body);
  if (status === 401 || status === 403)
    return new GatewayProviderStopError("configuration", status, body);
  return null;
}

export async function coordinatedGatewayRequest(
  stub: Pick<AiGatewayEgressRpc, "fetch">,
  provider: GatewayProvider,
  request: GatewayFetchRequest,
  controls: GatewayControls,
) {
  const deadline =
    Date.now() + Math.min(controls.requestTimeoutMs ?? 30_000, 30_000);
  const query = await request.query();
  for (;;) {
    request.signal?.throwIfAborted();
    const response = await stub.fetch(
      new Request("https://gateway.internal/egress", {
        method: "POST",
        body: JSON.stringify({
          provider,
          endpoint: request.endpoint,
          headers: Object.fromEntries(request.headers),
          query,
          controls,
        }),
        signal: request.signal,
      }),
    );
    if (response.headers.get("x-cubby-admission-wait") !== "true")
      return response;
    await response.body?.cancel();
    const delay = Math.max(
      1_000,
      Number(response.headers.get("retry-after") ?? 1) * 1_000,
    );
    const retryAt = Date.now() + delay;
    deferCooperativeAiWork(retryAt);
    if (retryAt >= deadline) throw new GatewayAdmissionWaitError(retryAt);
    await sleep(delay, request.signal);
  }
}
