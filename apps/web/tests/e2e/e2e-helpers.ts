import type { TaskStatus } from "@cubby/schemas/project";
import { expect, type Locator, type Page } from "@playwright/test";
import { TASK_STATUS_LABELS } from "~/app/tasks/task-options";

/**
 * Wait for React to hydrate a form after SSR.
 *
 * Uses `networkidle` (not `domcontentloaded`) so that all JS bundles have been
 * downloaded AND executed before we start interacting with the page.
 */
export async function waitForFormHydration(page: Page) {
  await page.waitForLoadState("networkidle");
  // Match any common submit-button text (Create, Save, Move …)
  await expect(
    page.getByRole("button", { name: /Create|Save|Move/ }),
  ).toBeVisible({ timeout: 15000 });
}

/**
 * Open an EntityPicker, type in its single combobox input, and select a result.
 *
 * Uses Playwright's `toPass` retry to handle the SSR-hydration race:
 * keeps clicking the combobox until `aria-expanded` becomes "true",
 * which means React's onClick handler has fired and set the open state.
 */
export async function selectComboboxItem(
  page: Page,
  combobox: Locator,
  itemName: string,
) {
  await expect(combobox).toBeVisible({ timeout: 10000 });

  // Retry click until React's state update sets aria-expanded="true"
  await expect(async () => {
    await combobox.click();
    await expect(combobox).toHaveAttribute("aria-expanded", "true");
  }).toPass({ timeout: 5000 });

  await combobox.fill(itemName);

  // Wait for and click the matching option. The name regex is anchored to the
  // start: while the debounced search is still loading, the popup shows a
  // "Create new <label>: <itemName>" button whose accessible name also
  // contains itemName — an unanchored (substring) match clicks it and opens
  // the quick-create dialog, wedging the whole form behind aria-hidden.
  const escapedName = itemName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const option = page.getByRole("option", {
    name: new RegExp(`^${escapedName}`),
  });
  await expect(option).toBeVisible({ timeout: 10000 });

  // Click, then verify the selection actually registered (popup closed). The
  // option's onClick is a React handler — a click can silently no-op if the
  // list re-renders mid-click (debounced search swaps the option nodes).
  await expect(async () => {
    await option.click();
    await expect(combobox).toHaveAttribute("aria-expanded", "false", {
      timeout: 1000,
    });
  }).toPass({ timeout: 10000 });
}

/**
 * Fill an input field with proper React event handling.
 *
 * Uses `pressSequentially` so that controlled inputs see each keystroke,
 * then blurs to trigger any `onBlur` validation.
 */
export async function fillInput(
  page: Page,
  placeholder: string,
  value: string,
) {
  const input = page.getByPlaceholder(placeholder);
  await expect(input).toBeVisible();
  await expect(input).toBeEnabled();
  await input.click();
  await input.clear();
  await input.pressSequentially(value, { delay: 10 });
  await input.blur();
}

/**
 * Locate the inline cell editor's input.
 *
 * `EditableCell`'s editor is portaled to <body> via `CellEditorOverlay`, so it
 * is NOT under the row it edits. Scope by the overlay's stable `data-slot`
 * instead of `input:focus` — the editor's `autoFocus` is a race (the trigger
 * can keep focus after the opening click, and the input is briefly
 * `disabled={isPending}` during a commit), so `input:focus` intermittently
 * matches nothing and hangs `.fill()` for the full test timeout. Only one
 * editor overlay is mounted at a time (`edit.isEditing`), so no row scoping is
 * needed.
 */
function cellEditorInput(page: Page): Locator {
  return page.locator('[data-slot="cell-editor-overlay"] input');
}

/**
 * Fill the open inline cell editor and commit with Enter.
 *
 * The caller opens the editor first (clicking "Edit value"). `.fill()` focuses
 * the element itself, so this never depends on `autoFocus` landing; the
 * `toBeEnabled` wait rides out the `disabled={isPending}` window.
 */
export async function fillCellEditor(page: Page, value: string) {
  const input = cellEditorInput(page);
  await expect(input).toBeVisible();
  await expect(input).toBeEnabled();
  await input.fill(value);
  await input.press("Enter");
}

/**
 * Open the global command palette via the header "Search" trigger and return
 * its dialog.
 *
 * `exact: true` is load-bearing: a non-exact name is a substring match, and the
 * ProblemsBadge renders an "N missing a search embedding — Click to view" link
 * (role=button) whenever a freshly-created entity hasn't been embedded yet —
 * that "search" substring collides with the trigger and trips strict mode
 * intermittently. This was the shard-2 command-palette flake.
 *
 * The overlay-count wait is secondary hardening: a dialog that just closed
 * (e.g. a quick-add form) keeps its Base UI backdrop (`data-slot="dialog-overlay"`,
 * `fixed inset-0 z-50`) mounted for its ~100ms fade-out, and that backdrop can
 * intercept pointer events over the trigger while `expect(dialog).not.toBeVisible()`
 * (which only checks the dialog *panel*) has already passed.
 */
export async function openCommandPalette(page: Page): Promise<Locator> {
  await expect(page.locator('[data-slot="dialog-overlay"]')).toHaveCount(0);
  // The account trigger replaces its SSR placeholder only after hydration,
  // so it is a reliable shell-wide signal that click handlers are attached.
  await expect(
    page.getByRole("button", { name: "Account menu" }),
  ).toBeVisible();
  const trigger = page.getByRole("button", { name: "Search", exact: true });
  await expect(trigger).toBeEnabled();
  await trigger.click();
  const palette = page.getByRole("dialog");
  await expect(palette).toBeVisible({ timeout: 10000 });
  return palette;
}

export async function createLocation(
  page: Page,
  name: string,
  opts: { parentName?: string } = {},
): Promise<string> {
  await page.goto("/locations/new");
  await waitForFormHydration(page);
  await page.getByPlaceholder("Enter location name").fill(name);
  if (opts.parentName) {
    await selectComboboxItem(
      page,
      page.getByRole("combobox", { name: /parent location/i }),
      opts.parentName,
    );
  }
  await page.getByRole("button", { name: /^Create$/ }).click();
  await expect(page).toHaveURL(
    /\/locations\/LOC-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4}/,
    {
      timeout: 15000,
    },
  );
  await expect(page.getByText(name).first()).toBeVisible({ timeout: 10000 });
  const shortcode = new URL(page.url()).pathname.match(
    /\/locations\/(LOC-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4})/,
  )?.[1];
  if (!shortcode)
    throw new Error(`Location shortcode missing from ${page.url()}`);
  return shortcode;
}

export async function createTask(
  page: Page,
  name: string,
  opts: { dueDate?: string; status?: TaskStatus } = {},
) {
  await page.goto("/tasks");
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: "New", exact: true }).click();

  const dialog = page.getByRole("dialog", { name: "New Task" });
  await expect(dialog).toBeVisible({ timeout: 10000 });
  await dialog.getByLabel("Name").fill(name);
  if (opts.status && opts.status !== "not_started") {
    await selectComboboxItem(
      page,
      dialog.getByRole("combobox", { name: "Status" }),
      TASK_STATUS_LABELS[opts.status],
    );
  }
  if (opts.dueDate) {
    const [year, month, day] = opts.dueDate.split("-").map(Number);
    if (!year || !month || !day) {
      throw new Error(`Invalid task due date: ${opts.dueDate}`);
    }
    const target = new Date(year, month - 1, day);
    const today = new Date();
    const monthDelta =
      year * 12 + month - 1 - (today.getFullYear() * 12 + today.getMonth());
    await dialog.getByLabel("Due date").click();
    const navName =
      monthDelta < 0 ? "Go to the Previous Month" : "Go to the Next Month";
    for (let step = 0; step < Math.abs(monthDelta); step++) {
      await page.getByRole("button", { name: navName }).click();
    }
    const ordinal =
      day % 10 === 1 && day % 100 !== 11
        ? "st"
        : day % 10 === 2 && day % 100 !== 12
          ? "nd"
          : day % 10 === 3 && day % 100 !== 13
            ? "rd"
            : "th";
    const weekday = new Intl.DateTimeFormat("en-US", {
      weekday: "long",
    }).format(target);
    const monthName = new Intl.DateTimeFormat("en-US", {
      month: "long",
    }).format(target);
    await page
      .getByRole("button", {
        name: `${weekday}, ${monthName} ${day}${ordinal}, ${year}`,
        exact: true,
      })
      .click();
  }
  await dialog.getByRole("button", { name: /^Create$/ }).click();
  await expect(dialog).not.toBeVisible({ timeout: 10000 });
}

export async function createProduct(
  page: Page,
  name: string,
  opts: { manufacturer?: string } = {},
) {
  await page.goto("/products/new");
  await waitForFormHydration(page);
  await page.getByPlaceholder("Enter product name").fill(name);
  if (opts.manufacturer !== undefined) {
    await page.getByPlaceholder("Enter manufacturer").fill(opts.manufacturer);
  }
  await page.getByRole("button", { name: /^Create$/ }).click();
  await expect(page).toHaveURL(
    /\/products\/PRD-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4}/,
    {
      timeout: 15000,
    },
  );
  // PageHero renders the entity label ("Product") as an eyebrow above the <h1>,
  // which is the bare product name.
  await expect(page.getByRole("heading", { level: 1, name })).toBeVisible({
    timeout: 10000,
  });
  await expect(page.getByText("Basic Information")).toBeVisible();
}

// Asserts the ingredient detail URL and the <h1> name heading, so every spec
// that seeds an ingredient this way also covers the create flow itself — the
// standalone create-ingredient spec was deleted in favour of that.
export async function createIngredientViaForm(page: Page, name: string) {
  await page.goto("/ingredients/new");
  await waitForFormHydration(page);
  await fillInput(page, "Enter ingredient name", name);
  await page.getByRole("button", { name: /^Create$/ }).click();
  const ingredientShortcodeRe =
    /\/ingredients\/ING-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4}/;
  await expect(page).toHaveURL(ingredientShortcodeRe, { timeout: 15000 });
  await expect(page.getByRole("heading", { level: 1 })).toContainText(name, {
    timeout: 10000,
  });
}

// Create a product linked to an existing ingredient, with two unit→price
// conversions: 1 cup = $2.50 and 100 g = $1.50. These exact mappings are what
// the recipe full-flow cost/weight assertions depend on (2 cups → $5.00, and
// 333 g via the chained cup→g conversion), so don't change them here. Asserts
// the product detail URL and the <h1> name heading.
export async function createProductWithIngredientMappings(
  page: Page,
  opts: { name: string; manufacturer: string; ingredientName: string },
) {
  await page.goto("/products/new");
  await waitForFormHydration(page);
  await fillInput(page, "Enter product name", opts.name);
  await fillInput(page, "Enter manufacturer", opts.manufacturer);

  // Link to the ingredient through the picker’s single labeled search input.
  await selectComboboxItem(
    page,
    page.getByRole("combobox", { name: /ingredient/i }),
    opts.ingredientName,
  );

  // Rows use compact "Qty"/"Unit" labels that repeat per row, so target the
  // stable input ids instead. The "from" value defaults to 1.
  await page.getByRole("button", { name: "Add conversion" }).click();
  const firstFromUnit = page.locator('[id="unitMappings.0.a.unit"]');
  await expect(firstFromUnit).toBeVisible({ timeout: 10000 });
  await firstFromUnit.fill("cup");
  await page.locator('[id="unitMappings.0.b.value"]').fill("2.50");
  await page.locator('[id="unitMappings.0.b.unit"]').fill("dollar");

  await page.getByRole("button", { name: "Add conversion" }).click();
  const secondFromValue = page.locator('[id="unitMappings.1.a.value"]');
  await expect(secondFromValue).toBeVisible({ timeout: 10000 });
  await secondFromValue.fill("100");
  await page.locator('[id="unitMappings.1.a.unit"]').fill("grams");
  await page.locator('[id="unitMappings.1.b.value"]').fill("1.50");
  await page.locator('[id="unitMappings.1.b.unit"]').fill("dollar");

  await page.getByRole("button", { name: /^Create$/ }).click();
  await expect(page).toHaveURL(
    /\/products\/PRD-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4}/,
    {
      timeout: 15000,
    },
  );
  // PageHero renders the entity label ("Product") as an eyebrow above the <h1>,
  // which is the bare product name.
  await expect(
    page.getByRole("heading", { level: 1, name: opts.name }),
  ).toBeVisible({ timeout: 10000 });
}

export async function addInventory(
  page: Page,
  productName: string,
  locationName: string,
  quantity: number,
  unit: string,
) {
  await page.goto("/inventory/new");
  await waitForFormHydration(page);

  await selectComboboxItem(
    page,
    page.getByRole("combobox", { name: /product/i }),
    productName,
  );

  await selectComboboxItem(
    page,
    page.getByRole("combobox", { name: /location/i }),
    locationName,
  );

  await page.getByLabel("Amount Value").fill(quantity.toString());

  await page.getByRole("textbox", { name: "Amount Unit" }).fill(unit);

  await page.getByRole("button", { name: /^Create$/ }).click();
  await expect(page).toHaveURL(
    /\/inventory\/INV-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4}/,
    {
      timeout: 15000,
    },
  );
  await expect(page.getByText(productName).first()).toBeVisible({
    timeout: 10000,
  });
}
