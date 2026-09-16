import { isCancelledError, type QueryClient } from "@tanstack/react-query";
import { type JSONType, z } from "zod";

import { FLAGS } from "~/lib/flags";
import {
  type OperationOutcome,
  type OperationTransport,
  recordMutation,
  recordQueryOperation,
} from "~/lib/perf/perf-store";
import type { StartOperationId } from "~/lib/start-operation-observability";
import {
  registeredStartOperationKind,
  startOperationHeaders,
} from "~/lib/start-operation-observability";

import {
  type OperationDescriptor,
  operationDescriptor,
} from "./operation-meta";

type ObservedKind = "query" | "mutation";

export interface ObservedOperation extends OperationDescriptor {
  operation: StartOperationId;
  id: string;
  kind: ObservedKind;
  startedAt: number;
}

let operationSequence = 0;

const nextOperationId = () => `op-${++operationSequence}`;

type ObservedFailure = Error | JSONType;

const parseObservedFailure = <Failure>(failure: Failure): ObservedFailure => {
  if (failure instanceof Error) return failure;
  const parsed = z.json().safeParse(failure);
  return parsed.success
    ? parsed.data
    : new Error("A non-serializable value was thrown");
};

function isOperationCancellation(error: ObservedFailure): boolean {
  return (
    isCancelledError(error) ||
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError")
  );
}

const consoleEnabled = () => "window" in globalThis && FLAGS.queryLogger;

export function beginObservedOperation(options: {
  kind: ObservedKind;
  transport: OperationTransport;
  operation: StartOperationId;
  entity?: string;
  speculative?: boolean;
  input?: unknown;
}): ObservedOperation {
  const observed: ObservedOperation = {
    id: nextOperationId(),
    kind: options.kind,
    transport: options.transport,
    operation: options.operation,
    entity: options.entity,
    speculative: options.speculative ?? false,
    observedByTransport: true,
    startedAt: performance.now(),
  };
  if (consoleEnabled()) {
    console.log(`>> ${observed.id} ${observed.operation}`, {
      transport: observed.transport,
      entity: observed.entity,
      input: options.input,
    });
  }
  return observed;
}

export function finishObservedOperation<Failure>(
  observed: ObservedOperation,
  options: { result?: unknown; error?: Failure },
): void {
  const failure =
    options.error === undefined
      ? undefined
      : parseObservedFailure(options.error);
  const durationMs = performance.now() - observed.startedAt;
  const outcome: OperationOutcome = failure
    ? isOperationCancellation(failure)
      ? "cancelled"
      : "error"
    : "success";
  if (observed.kind === "query") {
    recordQueryOperation({
      id: observed.id,
      operation: observed.operation,
      transport: observed.transport,
      kind: "fetch",
      durationMs,
      outcome,
    });
  } else {
    recordMutation({
      id: observed.id,
      operation: observed.operation,
      transport: observed.transport,
      entity: observed.entity,
      outcome,
      durationMs,
    });
  }
  const payload = {
    transport: observed.transport,
    entity: observed.entity,
    elapsedMs: Math.round(durationMs),
    outcome,
    ...(failure ? { error: failure } : { result: options.result }),
  };
  if (outcome === "error" && "window" in globalThis)
    console.error(`<< ${observed.id} ${observed.operation}`, payload);
  else if (consoleEnabled())
    console.log(`<< ${observed.id} ${observed.operation}`, payload);
}

export function operationHeaders(observed: ObservedOperation): HeadersInit {
  return startOperationHeaders({
    ...observed,
    kind: registeredStartOperationKind(observed.operation),
  });
}

const queryStarts = new Map<
  string,
  { descriptor: OperationDescriptor; startedAt: number }
>();
const mutationStarts = new Map<
  number,
  { descriptor: OperationDescriptor; id: string; startedAt: number }
>();

const finishCachedQuery = (hash: string, outcome: OperationOutcome): void => {
  const active = queryStarts.get(hash);
  if (!active) return;
  queryStarts.delete(hash);
  recordQueryOperation({
    operation: active.descriptor.operation,
    transport: active.descriptor.transport,
    kind: "fetch",
    durationMs: performance.now() - active.startedAt,
    outcome,
  });
};

/** Install once when the browser QueryClient is created, before hydration. */
export function installOperationRecorder(queryClient: QueryClient): () => void {
  const unsubscribeQuery = queryClient.getQueryCache().subscribe((event) => {
    const query = event.query;
    const descriptor = operationDescriptor(query.queryKey, query.meta);
    if (
      event.type === "added" &&
      query.state.status === "success" &&
      query.state.fetchStatus === "idle"
    ) {
      recordQueryOperation({
        operation: descriptor.operation,
        transport: descriptor.transport,
        kind: "hydrated",
      });
      return;
    }
    if (
      event.type === "observerAdded" &&
      query.state.status === "success" &&
      query.state.fetchStatus === "idle"
    ) {
      recordQueryOperation({
        operation: descriptor.operation,
        transport: descriptor.transport,
        kind: "reuse",
      });
      return;
    }
    if (descriptor.observedByTransport || event.type !== "updated") return;
    if (event.action.type === "fetch") {
      queryStarts.set(query.queryHash, {
        descriptor,
        startedAt: performance.now(),
      });
      return;
    }
    if (event.action.type === "error") {
      finishCachedQuery(
        query.queryHash,
        isOperationCancellation(event.action.error) ? "cancelled" : "error",
      );
      return;
    }
    if (event.action.type === "success") {
      finishCachedQuery(query.queryHash, "success");
    }
  });

  const unsubscribeMutation = queryClient
    .getMutationCache()
    .subscribe((event) => {
      if (event.type !== "updated") return;
      const mutation = event.mutation;
      const meta = mutation.meta;
      const descriptor: OperationDescriptor = {
        transport: meta?.transport ?? "client",
        operation:
          meta?.operation ??
          operationDescriptor(mutation.options.mutationKey ?? [], meta)
            .operation,
        entity: meta?.entity,
        speculative: false,
        observedByTransport: meta?.observedByTransport ?? false,
      };
      if (descriptor.observedByTransport) return;
      if (event.action.type === "pending") {
        mutationStarts.set(mutation.mutationId, {
          descriptor,
          id: nextOperationId(),
          startedAt: performance.now(),
        });
        return;
      }
      if (event.action.type !== "success" && event.action.type !== "error")
        return;
      const active = mutationStarts.get(mutation.mutationId);
      if (!active) return;
      mutationStarts.delete(mutation.mutationId);
      const outcome: OperationOutcome =
        event.action.type === "success"
          ? "success"
          : isOperationCancellation(event.action.error)
            ? "cancelled"
            : "error";
      recordMutation({
        id: active.id,
        operation: active.descriptor.operation,
        transport: active.descriptor.transport,
        entity: active.descriptor.entity,
        outcome,
        durationMs: performance.now() - active.startedAt,
      });
    });

  return () => {
    unsubscribeQuery();
    unsubscribeMutation();
    queryStarts.clear();
    mutationStarts.clear();
  };
}
