import type { Page, Response } from "@playwright/test";

import { BROWSER_OPERATION_PATH } from "~/lib/browser-operation-path";
import { dispatchesOperation } from "./dispatch-wire";

const operationHeader = (response: Response, suffix = "") =>
  response.request().headers()[`x-cubby-operation${suffix}`];

/**
 * Synchronize on the gesture's successful mutation; assertions stay UI-only.
 *
 * Pass `refetchOperation` before a persistence reload: it also waits for the
 * invalidation refetch the mutation triggers. Reloading while that refetch is
 * in flight can abort it and fail the next read in the local Worker harness.
 */
export async function waitForDndMutation(
  page: Page,
  entity: string,
  refetchOperation?: string,
  mutationOperation?: string,
) {
  let committed = false;
  const settled = await page.waitForResponse((response) => {
    if (
      !committed &&
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === BROWSER_OPERATION_PATH &&
      operationHeader(response, "-kind") === "mutation" &&
      (mutationOperation
        ? operationHeader(response) === mutationOperation
        : operationHeader(response, "-entity") === entity) &&
      response.ok()
    ) {
      committed = true;
      return refetchOperation === undefined;
    }
    // Responses are observed in arrival order, so a match here comes from the
    // mutation's invalidation, not from the page load before the gesture.
    return (
      committed &&
      refetchOperation !== undefined &&
      dispatchesOperation(response.request(), refetchOperation)
    );
  });
  // A response resolves at its headers; the framed body can still be streaming.
  // Playwright never reports `finished` for a batched NDJSON body the page
  // reads as a stream (verified: the stream itself closes in ~50 ms), so a
  // batched refetch counts as settled at its headers.
  if (!(settled.headers()["content-type"] ?? "").includes("x-ndjson"))
    await settled.finished();
}
