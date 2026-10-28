import { entitySchema } from "@cubby/schemas/entity";
import type { DehydratedState } from "@tanstack/react-query";
import type { AnyRouter } from "@tanstack/react-router";

import { loadBrowserEntityMetadata } from "~/entity/metadata-loader";

type TransportQuery = DehydratedState["queries"][number];
type TransportQueries = DehydratedState["queries"];

function metadataEntity(query: TransportQuery) {
  if (query.queryKey[0] !== "entity-metadata") return null;
  return entitySchema.parse(query.queryKey[1]);
}

function serializeQuery(query: TransportQuery): TransportQuery {
  const entity = metadataEntity(query);
  if (entity === null) return query;
  const promise = query.promise?.then(() => entity);
  void promise?.catch(() => {
    // SILENT: Transport must retain the rejection even if SSR cancels before consuming it.
  });
  return {
    ...query,
    state: {
      ...query.state,
      ...(query.state.data !== undefined ? { data: entity } : {}),
    },
    ...(promise ? { promise } : {}),
  };
}

async function reconstructQuery(
  query: TransportQuery,
): Promise<TransportQuery> {
  const entity = metadataEntity(query);
  if (entity === null) return query;
  const reconstruct = (identity: unknown) => {
    if (entitySchema.parse(identity) !== entity)
      throw new Error("Entity metadata admission does not match its query key");
    return loadBrowserEntityMetadata(entity);
  };
  // Map pending promises immediately, but never put a Promise in successful data.
  // Query retains ownership of pending/error publication and Suspense wakeups.
  const promise = query.promise?.then(reconstruct);
  // Import errors can precede initial-state admission. Query will consume this
  // rejection after the batch is admitted; keep it handled in the meantime.
  void promise?.catch(() => {
    // SILENT: Query consumes this same rejected promise after batch admission.
  });
  try {
    const data =
      query.state.data === undefined
        ? undefined
        : await reconstruct(query.state.data);
    return {
      ...query,
      state: { ...query.state, data },
      ...(promise ? { promise } : {}),
    };
  } catch (cause) {
    // A failed chunk belongs to this Query, not the shared hydration stream.
    return {
      ...query,
      state: {
        ...query.state,
        data: undefined,
        status: "error",
        error:
          cause instanceof Error
            ? cause
            : new Error("Metadata import failed", { cause }),
        errorUpdatedAt: Date.now(),
        fetchStatus: "idle",
      },
      ...(promise ? { promise } : {}),
    };
  }
}

/** Install after TanStack's SSR Query integration. It still owns hydration,
 * stream consumption, cancellation, errors and request cleanup. This wrapper
 * changes only metadata query data on its existing initial/stream transport. */
export function installEntityMetadataTransport(router: AnyRouter) {
  if (router.isServer) {
    const dehydrate = router.options.dehydrate;
    router.options.dehydrate = async () => {
      const state = await dehydrate?.();
      if (!state) return state;
      // The installed integration produces this envelope; retain every other
      // router/query field rather than recreating its dehydration machinery.
      const initial: TransportQueries | undefined = state.query.initial;
      const stream: ReadableStream<TransportQueries> = state.query.stream;
      return {
        ...state,
        query: {
          ...state.query,
          ...(initial ? { initial: initial.map(serializeQuery) } : {}),
          stream: stream.pipeThrough(
            new TransformStream<TransportQueries, TransportQueries>({
              transform(queries, controller) {
                controller.enqueue(queries.map(serializeQuery));
              },
            }),
          ),
        },
      };
    };
    return;
  }
  const hydrate = router.options.hydrate;
  router.options.hydrate = async (state) => {
    const initial: TransportQueries | undefined = state.query.initial;
    const stream: ReadableStream<TransportQueries> = state.query.stream;
    try {
      const reconstructed = initial
        ? await Promise.all(initial.map(reconstructQuery))
        : undefined;
      await hydrate?.({
        ...state,
        query: {
          ...state.query,
          ...(reconstructed ? { initial: reconstructed } : {}),
          stream: stream.pipeThrough(
            new TransformStream<TransportQueries, TransportQueries>({
              async transform(queries, controller) {
                controller.enqueue(
                  await Promise.all(queries.map(reconstructQuery)),
                );
              },
            }),
          ),
        },
      });
    } catch (error) {
      // Initial reconstruction can fail before the integration takes the reader.
      if (!stream.locked)
        await stream.cancel(error).catch(() => {
          // SILENT: Preserve the original admission error if cancellation also fails.
        });
      throw error;
    }
  };
}
