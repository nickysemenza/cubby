import { AsyncLocalStorage } from "node:async_hooks";

import type { UnparsedError } from "~/lib/error-utils";

/**
 * What one producer call did on the wire (ADR 0029 section 8). The kernel
 * opens one ledger around every `produce`; the transport records whether a
 * request left, its admission hooks record a refusal that sent nothing, and
 * usage accounting records each call's charged cost.
 */
type Ledger = {
  transmitted: boolean;
  refusal: UnparsedError | undefined;
  costs: Promise<number | null>[];
};

const ledgers = new AsyncLocalStorage<Ledger>();

/** A producer's transport calls share its one Ask claim, without a nested claim. */
export const insideProduce = (): boolean => ledgers.getStore() !== undefined;

/** A request left, or may have left, the transport. */
export function markTransmitted(): void {
  const ledger = ledgers.getStore();
  if (ledger) ledger.transmitted = true;
}

/**
 * Declare that a request was refused before the provider did paid work: a
 * pre-request admission hook refused it, or the provider answered with a
 * classified funding or configuration stop. `wait` is what the kernel settles
 * the Ask with; the error itself is returned unchanged for the caller to throw.
 */
export function refusedBeforeSending<E extends UnparsedError>(
  error: E,
  wait: UnparsedError = error,
): E {
  const ledger = ledgers.getStore();
  if (ledger) ledger.refusal = wait;
  return error;
}

/** The charged cost in dollars of one usage row the call wrote; null when unknown. */
export function recordProducedCost(cost: Promise<number | null>): void {
  ledgers.getStore()?.costs.push(cost.catch(() => null));
}

export type ProduceOutcome<T> =
  | { status: "produced"; value: T; costMicros: number | null }
  | {
      status: "failed";
      error: UnparsedError;
      /** The refusal that proves nothing was sent, or null. */
      unsent: UnparsedError | null;
    };

/**
 * Run one producer call under its ledger. Its cost is the sum of the charged
 * costs it recorded, unknown when it recorded none or any is unknown. A
 * failure is proven unsent only when a refusal was declared and no request
 * left during the whole call.
 */
export async function runProduce<T>(
  work: () => Promise<T>,
): Promise<ProduceOutcome<T>> {
  const ledger: Ledger = { transmitted: false, refusal: undefined, costs: [] };
  try {
    const value = await ledgers.run(ledger, work);
    const costs = await Promise.all(ledger.costs);
    const known = costs.length > 0 && costs.every((cost) => cost !== null);
    return {
      status: "produced",
      value,
      costMicros: known
        ? Math.round(costs.reduce((sum, cost) => sum + cost!, 0) * 1_000_000)
        : null,
    };
  } catch (error) {
    return {
      status: "failed",
      error,
      unsent: ledger.transmitted ? null : (ledger.refusal ?? null),
    };
  }
}
