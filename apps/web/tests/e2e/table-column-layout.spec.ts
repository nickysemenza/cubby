import type { Locator, Page } from "@playwright/test";

import {
  seedInventoryPrerequisites,
  seedVendorDisplayPrerequisite,
} from "./fixtures-catalog";
import { seedCookbookSourcePrerequisite } from "./fixtures-recipes";
import { createEntityFixture } from "./fixtures-core";
import { gotoAuthenticatedPage } from "./e2e-helpers";
import { expect, test } from "./e2e-test";

// Column layout is session state (docs/agents/web-ui-reference.md): every
// pointer and keyboard path through the one layout policy applies to the live
// header, keeps the locked structural columns at their edges, and a reload
// restores the declared default layout.

function headerIds(page: Page) {
  return page
    .locator("thead tr")
    .first()
    .locator("th[data-column-id]")
    .evaluateAll((cells) =>
      cells.map((cell) => cell.getAttribute("data-column-id") ?? ""),
    );
}

async function expectAuditTimestamps(page: Page, row: Locator) {
  for (const id of ["createdAt", "updatedAt"]) {
    const timestamp = row.locator(`[data-cell-col="${id}"]`);
    await expect(timestamp).toHaveText(/^(now|\d+(m|h|d|w|mo|y))$/);
    await timestamp.getByRole("button").hover();
    await expect(
      page.getByText(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/),
    ).toBeVisible();
  }
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
  const from = await center(handle);
  const body = await center(dragged);
  const targetCenter = await center(target);
  const to = {
    x: targetCenter.x - (body.x - from.x),
    y: targetCenter.y - (body.y - from.y),
  };
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 8, from.y + 8, { steps: 4 });
  await page.mouse.move(to.x, to.y, { steps: 16 });
  // Settle over the target so collision detection resolves it before drop.
  await page.mouse.move(to.x + 1, to.y, { steps: 2 });
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
  await page.setViewportSize({ width: 1440, height: 1600 });
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
  await expectAuditTimestamps(
    page,
    page.getByRole("row").filter({ hasText: name }).first(),
  );
  for (const id of [
    "dataQuality",
    "spendingProfile",
    "defaultSpendingCategoryId",
    "website",
    "notes",
    "purchaseCount",
  ]) {
    expect(defaults).toContain(id);
  }
  const header = (id: string) => page.locator(`th[data-column-id="${id}"]`);
  const grip = (id: string) =>
    header(id).locator(`[aria-label="Reorder ${id} column"]`);

  // Header, pointer: a same-region drag moves the column past its neighbour.
  // Both columns sit in the table's leading half, clear of auto-scroll.
  let expected = placedAfter(defaults, "dataQuality", "spendingProfile");
  await pointerDrag(
    page,
    grip("dataQuality"),
    header("dataQuality"),
    header("spendingProfile"),
  );
  await expect.poll(() => headerIds(page)).toEqual(expected);

  // Header, keyboard: pick up, step right twice, drop.
  const said = (text: string) => page.getByText(text, { exact: true });
  const pickedUp = (id: string) =>
    said(`Picked up: ${id} column.`).or(
      said(`Move target: ${id} column position.`),
    );
  await grip("spendingProfile").focus();
  await pressUntilAnnounced(page, "Space", pickedUp("spendingProfile"));
  await pressUntilAnnounced(
    page,
    "ArrowRight",
    said("Move target: dataQuality column position."),
  );
  await pressUntilAnnounced(
    page,
    "ArrowRight",
    said("Move target: defaultSpendingCategoryId column position."),
  );
  await pressUntilAnnounced(
    page,
    "Space",
    said(
      "Dropped: spendingProfile column, defaultSpendingCategoryId column position.",
    ),
  );
  // dnd-kit hands focus back to the handle so the next key keeps working, and
  // no cell editor claims those keys.
  await expect(grip("spendingProfile")).toBeFocused();
  expected = placedAfter(
    expected,
    "spendingProfile",
    "defaultSpendingCategoryId",
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

  // The audit pair follows the same visibility controls as domain columns.
  await dialog
    .getByRole("button", { name: "Hide Created", exact: true })
    .click();
  await expect
    .poll(() => headerIds(page))
    .toEqual(expected.filter((id) => id !== "createdAt"));
  await dialog
    .getByRole("button", { name: "Show Created", exact: true })
    .click();
  await expect.poll(() => headerIds(page)).toEqual(expected);

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
    dragHandle("Evidence expectation"),
    row("evidenceExpectation"),
    row("notes"),
  );
  expected = placedAfter(expected, "evidenceExpectation", "notes");
  await expect.poll(() => headerIds(page)).toEqual(expected);

  // A reorder inside a pinned region, from the dialog's buttons.
  const press = (name: string) =>
    dialog.getByRole("button", { name, exact: true }).click();
  await press("Pin Vendor to start");
  await expect(
    zone("Pinned start").locator('[data-column-id="name"]'),
  ).toBeVisible();
  expected = ["select", "image", "website", "name"].concat(
    expected.filter(
      (id) => !["select", "image", "website", "name"].includes(id),
    ),
  );
  await expect.poll(() => headerIds(page)).toEqual(expected);
  await press("Move Vendor earlier");
  expected = placedAfter(expected, "website", "name");
  await expect.poll(() => headerIds(page)).toEqual(expected);
  // Regression: the dialog listed pins in `columnOrder`, not pinned order,
  // and the next placement reverted the reorder.
  const zoneIds = (label: string) =>
    zone(label)
      .locator("[data-column-id]")
      .evaluateAll((rows) =>
        rows.map((row) => row.getAttribute("data-column-id") ?? ""),
      );
  await expect
    .poll(() => zoneIds("Pinned start"))
    .toEqual(["select", "image", "name", "website"]);

  // Pin then unpin round-trips an unrelated column to its own slot and
  // leaves the pinned reorder alone.
  await press("Pin Spend to start");
  await expect
    .poll(() => zoneIds("Pinned start"))
    .toEqual(["select", "image", "name", "website", "spend"]);
  await press("Unpin Spend");
  await expect.poll(() => headerIds(page)).toEqual(expected);

  // Regression: "Pin to end" appended past the row-actions column.
  const pinNotesEnd = dialog.getByRole("button", {
    name: "Pin Notes to end",
    exact: true,
  });
  expected = [
    ...expected.filter((id) => id !== "notes" && id !== "actions"),
    "notes",
    "actions",
  ];
  // The dialog's focus management can reclaim focus after a row remounts, so
  // a key may land elsewhere; the button disappears once Notes is pinned to
  // the end, which makes a retry safe.
  await expect(async () => {
    if ((await pinNotesEnd.count()) > 0) await pinNotesEnd.press("Enter");
    expect(await headerIds(page)).toEqual(expected);
  }).toPass();

  const moveEarlier = dialog.getByRole("button", {
    name: "Move Purchase count earlier",
    exact: true,
  });
  const beforeMove = expected;
  const purchaseCountIndex = expected.indexOf("purchaseCount");
  const before = expected[purchaseCountIndex - 1];
  if (!before) throw new Error("purchaseCount has no earlier neighbour");
  expected = placedAfter(expected, before, "purchaseCount");
  // Removing the focused Notes row schedules dialog focus restoration, which
  // can consume the next Enter. Retry only while the full order is unchanged;
  // an incorrect move or an overshoot must still fail.
  await expect(async () => {
    const current = await headerIds(page);
    if (current.join("\0") !== expected.join("\0")) {
      expect(current).toEqual(beforeMove);
      await moveEarlier.press("Enter");
    }
    await expect
      .poll(() => headerIds(page), { timeout: 1_000 })
      .toEqual(expected);
  }).toPass();
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

test("audit columns are visible on Inventory and client-backed Cookbook lists", async ({
  page,
}) => {
  test.setTimeout(60_000);
  const prefix = `Audit columns ${Date.now()}`;
  const name = `${prefix} product`;
  await seedInventoryPrerequisites(page, {
    locationName: `${prefix} shelf`,
    products: [{ name, quantity: 1, unit: "each" }],
  });
  await gotoAuthenticatedPage(
    page,
    `/inventory?productNameFilter=${encodeURIComponent(name)}`,
    page.getByRole("row").filter({ hasText: name }).first(),
  );
  expect((await headerIds(page)).slice(-3)).toEqual([
    "createdAt",
    "updatedAt",
    "actions",
  ]);
  await expectAuditTimestamps(
    page,
    page.getByRole("row").filter({ hasText: name }).first(),
  );

  const cookbookName = `${prefix} cookbook`;
  await seedCookbookSourcePrerequisite(page, cookbookName);
  await gotoAuthenticatedPage(
    page,
    `/cookbooks?searchQuery=${encodeURIComponent(cookbookName)}`,
    page.getByRole("row").filter({ hasText: cookbookName }).first(),
  );
  expect((await headerIds(page)).slice(-3)).toEqual([
    "createdAt",
    "updatedAt",
    "actions",
  ]);
  await expectAuditTimestamps(
    page,
    page.getByRole("row").filter({ hasText: cookbookName }).first(),
  );
});

test("Wish tree rows retain audit timestamps for wishes and candidate products", async ({
  page,
}) => {
  test.setTimeout(60_000);
  const name = `Timestamp wish ${Date.now()}`;
  const { products } = await seedInventoryPrerequisites(page, {
    locationName: `${name} shelf`,
    products: [{ name: `${name} candidate`, quantity: 1, unit: "each" }],
  });
  await createEntityFixture(page, "wish", {
    name,
    candidateProductIds: [products[0]!.id],
  });
  const wishRow = page
    .getByRole("row")
    .filter({ has: page.getByRole("link", { name, exact: true }) });
  await gotoAuthenticatedPage(
    page,
    `/wishes?searchQuery=${encodeURIComponent(name)}`,
    wishRow,
  );
  await expectAuditTimestamps(page, wishRow);
  await wishRow.getByRole("button", { name: "Expand", exact: true }).click();
  await expectAuditTimestamps(
    page,
    page
      .getByRole("row")
      .filter({ hasText: `${name} candidate` })
      .last(),
  );
});
