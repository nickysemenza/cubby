import { expect, type Locator, type Page } from "@playwright/test";

async function visibleCenter(locator: Locator) {
  await locator.scrollIntoViewIfNeeded();
  await expect(locator).toBeVisible();
  const box = await locator.boundingBox();
  if (!box) throw new Error("Drag endpoint has no bounding box");
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/** Drive the same pointer events a person produces, including activation travel. */
export async function dragByMouse(
  page: Page,
  source: Locator,
  target: Locator,
) {
  const from = await visibleCenter(source);
  const to = await visibleCenter(target);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let step = 1; step <= 12; step++) {
    const progress = step / 12;
    await page.mouse.move(
      from.x + (to.x - from.x) * progress,
      from.y + (to.y - from.y) * progress,
    );
  }
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
  await source.evaluate(
    () =>
      new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
  );
  for (const move of moves) await source.press(move);
  await source.press("Space");
}

/** Synchronize on the gesture's successful mutation; assertions stay UI-only. */
export function waitForDndMutation(page: Page, operation: string) {
  return page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().includes(`/api/trpc/${operation}`) &&
      response.ok(),
  );
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
    type: "touchstart" | "touchmove" | "touchend",
    point: { x: number; y: number },
  ) => {
    await source.evaluate(
      (element, { eventType, x, y }) => {
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
        const ended = eventType === "touchend";
        const event = document.createEvent("TouchEvent");
        event.initEvent(eventType, true, true);
        Object.defineProperties(event, {
          touches: { value: ended ? [] : [touch] },
          targetTouches: { value: ended ? [] : [touch] },
          changedTouches: { value: [touch] },
        });
        element.dispatchEvent(event);
      },
      { eventType: type, x: point.x, y: point.y },
    );
  };

  await emit("touchstart", from);
  await page.waitForTimeout(holdMs);
  // Responsive boards register empty destinations only after activation.
  const to = await visibleCenter(target);
  for (let step = 1; step <= 12; step++) {
    const progress = step / 12;
    await emit("touchmove", {
      x: from.x + (to.x - from.x) * progress,
      y: from.y + (to.y - from.y) * progress,
    });
    await page.waitForTimeout(16);
  }
  await emit("touchend", to);
}
