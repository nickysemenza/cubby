import type {
  GatewayControls,
  GatewayFetchRequest,
} from "@cubby/shared/ai/gateway-request";
import type { GatewayProvider } from "@cubby/shared/ai/models";
import { sleep } from "@cubby/shared/retry";

import type { UnparsedError } from "~/lib/error-utils";

import type { AiGatewayEgressRpc } from "./gateway-egress-contract";

export class GatewayAdmissionWaitError extends Error {
  constructor(readonly retryAt: number) {
    super("AI Gateway admission is waiting for shared capacity");
  }
}
export function isGatewayAdmissionWait(error: UnparsedError) {
  for (
    let depth = 0, current = error;
    depth < 8 && current instanceof Error;
    depth++, current = current.cause
  ) {
    if (current instanceof GatewayAdmissionWaitError) return true;
  }
  return false;
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
    if (retryAt >= deadline) throw new GatewayAdmissionWaitError(retryAt);
    await sleep(delay, request.signal);
  }
}
