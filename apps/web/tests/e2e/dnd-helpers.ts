import {
  expect,
  type Locator,
  type Page,
  type Response,
} from "@playwright/test";

async function visibleCenter(locator: Locator) {
  await locator.scrollIntoViewIfNeeded();
  await expect(locator).toBeVisible();
  return currentCenter(locator);
}

async function currentCenter(locator: Locator) {
  const box = await locator.boundingBox();
  if (!box) throw new Error("Drag endpoint has no bounding box");
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

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
        // Headless WebKit can suspend RAF while a pressed touch is active.
        // Keep the frame as the primary cadence signal, with a bounded browser
        // task fallback so the synthetic finger cannot hang indefinitely.
        const fallback = setTimeout(finish, 50);
        requestAnimationFrame(finish);
      }),
  );
}

function stepToward(
  current: { x: number; y: number },
  target: { x: number; y: number },
  remainingSteps: number,
) {
  return {
    x: current.x + (target.x - current.x) / remainingSteps,
    y: current.y + (target.y - current.y) / remainingSteps,
  };
}

/** Drive the same pointer events a person produces, including activation travel. */
export async function dragByMouse(
  page: Page,
  source: Locator,
  target: Locator,
) {
  let current = await visibleCenter(source);
  await page.mouse.move(current.x, current.y);
  await page.mouse.down();
  await visibleCenter(target);
  for (let remaining = 12; remaining > 1; remaining -= 1) {
    current = stepToward(current, await currentCenter(target), remaining);
    await page.mouse.move(current.x, current.y);
    await nextAnimationFrame(source);
  }
  current = await currentCenter(target);
  await page.mouse.move(current.x, current.y);
  await page.mouse.up();
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
 * in flight aborts it, and local workerd then failed the next read with
 * "Network connection lost." (iPhone WebKit CI flake, 2026-09-22).
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
      response.url().includes("/_serverFn/") &&
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

/**
 * Playwright's touchscreen API supports taps only. Dispatch legacy TouchEvents
 * in WebKit so the real dnd-kit TouchSensor sees its long-press and movement.
 */
export async function dragByTouch(
  page: Page,
  source: Locator,
  target: Locator,
  holdMs = 300,
) {
  const from = await visibleCenter(source);
  const emit = async (
    eventTypes: readonly ("touchstart" | "touchmove" | "touchend")[],
    point: { x: number; y: number },
  ) => {
    await source.evaluate(
      (element, { types, x, y }) => {
        // WebKit exposes `Touch` but rejects its constructor. createEvent
        // still returns a real TouchEvent; dnd-kit only reads this public data.
        const touch = {
          identifier: 1,
          target: element,
          clientX: x,
          clientY: y,
          pageX: x + window.scrollX,
          pageY: y + window.scrollY,
          screenX: x,
          screenY: y,
          radiusX: 1,
          radiusY: 1,
          rotationAngle: 0,
          force: 1,
        };
        for (const eventType of types) {
          const ended = eventType === "touchend";
          const event = document.createEvent("TouchEvent");
          event.initEvent(eventType, true, true);
          Object.defineProperties(event, {
            touches: { value: ended ? [] : [touch] },
            targetTouches: { value: ended ? [] : [touch] },
            changedTouches: { value: [touch] },
          });
          element.dispatchEvent(event);
        }
      },
      { types: eventTypes, x: point.x, y: point.y },
    );
  };

  await emit(["touchstart"], from);
  await page.waitForTimeout(holdMs);
  // Responsive boards register empty destinations only after activation.
  await visibleCenter(target);
  let current = from;
  for (let remaining = 12; remaining > 1; remaining -= 1) {
    current = stepToward(current, await currentCenter(target), remaining);
    await emit(["touchmove"], current);
    await nextAnimationFrame(source);
  }
  // Keep the final move and release in one browser task so autoscroll cannot
  // move the destination between targeting it and committing the drop.
  await emit(["touchmove", "touchend"], await currentCenter(target));
}
