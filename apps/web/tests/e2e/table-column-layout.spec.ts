import type { Locator, Page } from "@playwright/test";

import { seedVendorDisplayPrerequisite } from "./fixtures/catalog";
import { gotoAuthenticatedPage } from "./support/e2e-helpers";
import { expect, test } from "./support/e2e-test";

// Column layout is session state (apps/web/docs/web-ui-reference.md): every
// pointer and keyboard path through the one layout policy applies to the live
// header, keeps the locked structural columns at their edges, and a reload
// restores the declared default layout.

function headerIds(page: Page) {
  return page
    .locator("thead th[data-column-id]")
    .evaluateAll((cells) =>
      cells.map((cell) => cell.getAttribute("data-column-id") ?? ""),
    );
}

/** `ids` with `id` moved so it lands directly after `anchor`. */
function placedAfter(ids: readonly string[], id: string, anchor: string) {
  const rest = ids.filter((item) => item !== id);
  rest.splice(rest.indexOf(anchor) + 1, 0, id);
  return rest;
}

async function center(locator: Locator) {
  const box = await locator.boundingBox();
  if (!box) throw new Error("drag endpoint is not rendered");
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/**
 * A real mouse drag: past the 4px activation distance, then until the dragged
 * element's centre (not the grip's) sits on `target`'s centre — collision
 * detection compares centres, and a grip sits at its element's leading edge.
 */
async function pointerDrag(
  page: Page,
  handle: Locator,
  dragged: Locator,
  target: Locator,
) {
  await handle.hover();
  // Rest past the 250ms cell spill-over delay, as a user does before
  // pressing: a header's spill once covered the grip and swallowed the press.
  await page.waitForTimeout(400);
  await expect(page.locator("[data-cell-spill-overlay]")).toHaveCount(0);
  const from = await center(handle);
  const body = await center(dragged);
  const targetCenter = await center(target);
  const to = {
    x: targetCenter.x - (body.x - from.x),
    y: targetCenter.y - (body.y - from.y),
  };
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 8, from.y + 8);
  // Activation, target collision and the final update exercise native drag
  // behavior; interpolating sixteen input events adds seconds on CI.
  await page.mouse.move(to.x, to.y, { steps: 2 });
  // Settle over the target so collision detection resolves it before drop.
  await page.mouse.move(to.x + 1, to.y);
  await page.mouse.up();
}

/**
 * Presses `key` until dnd-kit's live region announces `announcement`. The
 * keyboard sensor attaches its key listener a tick after pick-up, so a key
 * sent in that window is dropped; the announcement is the observable state.
 */
async function pressUntilAnnounced(
  page: Page,
  key: string,
  announcement: Locator,
) {
  await expect(async () => {
    if ((await announcement.count()) === 0) await page.keyboard.press(key);
    await expect(announcement).toBeAttached({ timeout: 1_000 });
  }).toPass();
}

test("column layout changes by pointer and keyboard, keeps locked edges, and resets on reload", async ({
  page,
}) => {
  test.setTimeout(60_000);
  // Tall enough that every customizer zone renders without dialog scrolling.
  await page.setViewportSize({ width: 1440, height: 2400 });
  const name = `Layout vendor ${Date.now()}`;
  await seedVendorDisplayPrerequisite(page, name);
  const path = `/vendors?q=${encodeURIComponent(name)}`;
  await gotoAuthenticatedPage(
    page,
    path,
    page.getByRole("link", { name, exact: true }),
  );

  const defaults = await headerIds(page);
  expect(defaults.slice(0, 2)).toEqual(["select", "image"]);
  expect(defaults.at(-1)).toBe("actions");
  expect(defaults.slice(-3)).toEqual(["createdAt", "updatedAt", "actions"]);
  const header = (id: string) => page.locator(`th[data-column-id="${id}"]`);
  const grip = (id: string) =>
    header(id).locator(`[aria-label="Reorder ${id} column"]`);

  // Header, pointer: a same-region drag moves the column past its neighbour.
  // Both columns sit in the table's leading half, clear of auto-scroll.
  let expected = placedAfter(
    defaults,
    "spendingProfile",
    "defaultSpendingCategoryId",
  );
  await pointerDrag(
    page,
    grip("spendingProfile"),
    header("spendingProfile"),
    header("defaultSpendingCategoryId"),
  );
  await expect.poll(() => headerIds(page)).toEqual(expected);

  // Header, keyboard: pick up, step right twice, drop.
  const said = (text: string) => page.getByText(text, { exact: true });
  const pickedUp = (id: string) =>
    said(`Picked up: ${id} column.`).or(
      said(`Move target: ${id} column position.`),
    );
  await grip("defaultSpendingCategoryId").focus();
  await pressUntilAnnounced(
    page,
    "Space",
    pickedUp("defaultSpendingCategoryId"),
  );
  await pressUntilAnnounced(
    page,
    "ArrowRight",
    said("Move target: spendingProfile column position."),
  );
  await pressUntilAnnounced(
    page,
    "ArrowRight",
    said("Move target: itemizationExpectation column position."),
  );
  await pressUntilAnnounced(
    page,
    "Space",
    said(
      "Dropped: defaultSpendingCategoryId column, itemizationExpectation column position.",
    ),
  );
  // dnd-kit hands focus back to the handle so the next key keeps working, and
  // no cell editor claims those keys.
  await expect(grip("defaultSpendingCategoryId")).toBeFocused();
  expected = placedAfter(
    expected,
    "defaultSpendingCategoryId",
    "itemizationExpectation",
  );
  await expect.poll(() => headerIds(page)).toEqual(expected);

  // Header, locked edge: the last movable column cannot be dropped past the
  // row-actions column, by keyboard or pointer.
  const lastMovable = expected.at(-2);
  if (!lastMovable) throw new Error("vendor table has no movable column");
  await grip(lastMovable).focus();
  await pressUntilAnnounced(page, "Space", pickedUp(lastMovable));
  await page.keyboard.press("ArrowRight");
  await pressUntilAnnounced(
    page,
    "Space",
    page
      .getByText(`Dropped: ${lastMovable} column`)
      .or(said(`${lastMovable} column was not moved.`)),
  );
  await pointerDrag(
    page,
    grip(lastMovable),
    header(lastMovable),
    header("actions"),
  );
  await expect.poll(() => headerIds(page)).toEqual(expected);

  // Customizer: pin transfer by pointer, ordering by keyboard.
  await page.getByRole("button", { name: "Actions", exact: true }).click();
  await page.getByRole("menuitem", { name: "Columns…" }).click();
  const dialog = page.getByRole("dialog", { name: "Columns" });
  await expect(dialog).toBeVisible();
  const zone = (label: string) =>
    dialog
      .getByRole("heading", { name: label, exact: true })
      .locator("xpath=following-sibling::div[1]");
  const dragHandle = (label: string) =>
    dialog.getByRole("button", { name: `Drag ${label}`, exact: true });
  const row = (id: string) => dialog.locator(`[data-column-id="${id}"]`);

  await pointerDrag(
    page,
    dragHandle("Website"),
    row("website"),
    zone("Pinned start"),
  );
  expected = ["select", "image", "website"].concat(
    expected.filter((id) => !["select", "image", "website"].includes(id)),
  );
  await expect.poll(() => headerIds(page)).toEqual(expected);

  // Regression: a downward drag within one zone landed one slot above where
  // the sortable preview showed it (here: back in its own slot).
  await pointerDrag(
    page,
    row("dataQuality").getByRole("button", { name: /^Drag / }),
    row("dataQuality"),
    row("notes"),
  );
  expected = placedAfter(expected, "dataQuality", "notes");
  await expect.poll(() => headerIds(page)).toEqual(expected);

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  expect(expected).not.toEqual(defaults);

  // Session-only: a reload restores the declared default layout.
  await gotoAuthenticatedPage(
    page,
    path,
    page.getByRole("link", { name, exact: true }),
  );
  await expect.poll(() => headerIds(page)).toEqual(defaults);
});
