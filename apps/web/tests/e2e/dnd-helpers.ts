import {
  expect,
  type Locator,
  type Page,
  type Response,
} from "@playwright/test";

import { BROWSER_OPERATION_PATH } from "~/lib/browser-operation-path";

async function nextAnimationFrame(locator: Locator) {
  await locator.evaluate(
    () =>
      new Promise<void>((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          clearTimeout(fallback);
          resolve();
        };
        // Use a frame for keyboard input cadence, with a bounded fallback if
        // the document stops producing frames.
        const fallback = setTimeout(finish, 50);
        requestAnimationFrame(finish);
      }),
  );
}

/** Activate dnd-kit from the focused grip, navigate, and commit. */
export async function dragByKeyboard(
  source: Locator,
  moves: readonly ("ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight")[],
) {
  await source.focus();
  await expect(source).toBeFocused();
  await source.press("Space");
  // KeyboardSensor attaches its document key listener in a zero-delay task.
  // One frame models human input cadence without a fixed sleep.
  await nextAnimationFrame(source);
  for (const move of moves) await source.press(move);
  await source.press("Space");
}

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
) {
  let committed = false;
  const settled = await page.waitForResponse((response) => {
    if (
      !committed &&
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === BROWSER_OPERATION_PATH &&
      operationHeader(response, "-kind") === "mutation" &&
      operationHeader(response, "-entity") === entity &&
      response.ok()
    ) {
      committed = true;
      return refetchOperation === undefined;
    }
    // Responses are observed in arrival order, so a match here comes from the
    // mutation's invalidation, not from the page load before the gesture.
    return committed && operationHeader(response) === refetchOperation;
  });
  // A response resolves at its headers; the framed body can still be streaming.
  await settled.finished();
}
