import { handleOperationRequest } from "~/server/operation-runtime/operation-dispatch.server";

/**
 * The `/api/operations` entry for the Worker route and the SSR transport. Its
 * declaration carries only wire types, so the client program imports it
 * without reaching server implementations.
 */
export function handleBrowserOperationDispatch(
  request: Request,
): Promise<Response> {
  return handleOperationRequest(request);
}
