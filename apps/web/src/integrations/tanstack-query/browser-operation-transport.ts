import superjson from "superjson";

import { BROWSER_OPERATION_PATH } from "~/lib/browser-operation-path";
import { fetchWithRequestDiagnostics } from "~/lib/request-id";
import type { StartOperationId } from "~/lib/start-operation-observability";
import { superJsonResultSchema } from "~/lib/superjson-wire";
import {
  type StartOperationResult,
  type UnparsedStartOperationData,
  unparsedStartOperationResultSchema,
} from "~/server/start-operation.contract";

export class BrowserOperationEndpointMissing extends Error {}

/** Use the same operation envelope as Start without importing its React handler. */
export async function dispatchBrowserOperation(
  operation: StartOperationId,
  input: UnparsedStartOperationData,
  transport: { signal?: AbortSignal; headers: HeadersInit },
): Promise<StartOperationResult<UnparsedStartOperationData>> {
  const headers = new Headers(transport.headers);
  headers.set("content-type", "application/json");
  const response = await fetchWithRequestDiagnostics(
    fetch,
    BROWSER_OPERATION_PATH,
    {
      method: "POST",
      headers,
      credentials: "same-origin",
      body: JSON.stringify(superjson.serialize({ operation, input })),
      signal: transport.signal,
    },
  );
  if (response.status === 404) throw new BrowserOperationEndpointMissing();
  const body: unknown = await response.json();
  const parsed = superJsonResultSchema.safeParse(body);
  if (!parsed.success) {
    throw new Error(
      `Browser operation dispatch returned HTTP ${response.status}: ${JSON.stringify(body)}`,
      { cause: parsed.error },
    );
  }
  return unparsedStartOperationResultSchema.parse(
    superjson.deserialize(parsed.data),
  );
}
