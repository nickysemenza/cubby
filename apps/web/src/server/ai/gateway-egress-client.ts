import { executionWaitReason } from "@cubby/schemas/execution";
import {
  classifyFundingRefusal,
  paidFundingRefusal,
} from "@cubby/shared/ai/funding-refusal";
import {
  type GatewayControls,
  type GatewayFetchRequest,
} from "@cubby/shared/ai/gateway-request";
import type { GatewayProvider } from "@cubby/shared/ai/models";
import { sleep } from "@cubby/shared/retry";

import { findErrorCause } from "~/lib/error-diagnostics";
import type { UnparsedError } from "~/lib/error-utils";
import {
  markTransmitted,
  refusedBeforeSending,
} from "~/server/kernel/produce-ledger";
import { WorkDeferredError } from "~/server/kernel/work-errors";

import { fundingResumeAt } from "./budget-window";
import {
  AiWorkDeferredError,
  deferCooperativeAiWork,
} from "./cooperative-work";
import type { AiGatewayEgressRpc } from "./gateway-egress-contract";

export class GatewayAdmissionWaitError extends Error {
  constructor(readonly retryAt: number) {
    super("AI Gateway admission is waiting for shared capacity");
  }
}
const gatewayAdmissionWait = (error: UnparsedError) =>
  findErrorCause(
    error,
    (cause): cause is GatewayAdmissionWaitError =>
      cause instanceof GatewayAdmissionWaitError,
  );

export const isGatewayAdmissionWait = (error: UnparsedError) =>
  gatewayAdmissionWait(error) !== undefined;

/**
 * The provider needs funding or configuration; wait without exhausting
 * targets. A funding stop is a funding wait (`fundingResumeAt`): while the
 * egress Durable Object holds the refusal an earlier probe is refused locally
 * anyway. A configuration stop probes again in 15 minutes.
 */
export class GatewayProviderStopError extends WorkDeferredError {
  constructor(
    readonly kind: "funding" | "configuration",
    readonly status: number,
    body: string,
  ) {
    super(
      `Decision request failed (${status}): ${body}`,
      kind === "funding"
        ? fundingResumeAt()
        : new Date(Date.now() + 15 * 60_000),
      kind === "funding"
        ? executionWaitReason.enum.ai_funding_window
        : executionWaitReason.enum.provider_capacity,
    );
  }
}

/** Classify the actual provider response once, before retrying or wrapping it. */
export function gatewayProviderStop(status: number, body: string) {
  if (
    status === 402 ||
    paidFundingRefusal(body) ||
    classifyFundingRefusal({ status, text: body, funding: "openai_credit" }) ||
    classifyFundingRefusal({ status, text: body, funding: "subscriber_credit" })
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

/**
 * Record a provider response in the produce ledger (ADR 0029 section 8). A
 * classified funding or configuration stop is the provider refusing the
 * request without paid work; every other response may have been billed.
 */
export async function receivedGatewayResponse(
  response: Response,
): Promise<Response> {
  if (!response.ok) {
    const body = await response
      .clone()
      .text()
      .catch(() => "");
    const stop = gatewayProviderStop(response.status, body);
    if (stop) {
      refusedBeforeSending(stop);
      return response;
    }
  }
  markTransmitted();
  return response;
}

/**
 * Record a failed send in the produce ledger and rethrow it. The egress
 * object's shared-capacity wait refuses before the provider sees the request;
 * any other failure may have left.
 */
export function failedGatewaySend(error: UnparsedError): never {
  const until =
    error instanceof GatewayAdmissionWaitError
      ? error.retryAt
      : error instanceof AiWorkDeferredError
        ? error.until
        : null;
  if (until === null) {
    markTransmitted();
    throw error;
  }
  throw refusedBeforeSending(
    error,
    new WorkDeferredError(
      "AI Gateway admission is waiting for shared capacity",
      new Date(until),
      "provider_capacity",
    ),
  );
}
