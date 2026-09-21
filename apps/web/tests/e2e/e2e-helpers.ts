import { expect, type Locator, type Page } from "@playwright/test";
import { z } from "zod";

/** The `get-session` status observed at a hydration failure, for attribution. */
async function observedSessionStatus(page: Page): Promise<number | "unknown"> {
  return await page.request
    .get("/api/auth/get-session")
    .then((response) => response.status())
    .catch(() => "unknown" as const);
}

/**
 * Wait until React has hydrated the authenticated application shell.
 *
 * The shell flips this explicit marker after the initial hydration render, so
 * it proves shell-level click handlers are attached across both desktop chrome
 * and contextual mobile chrome without coupling the wait to a route-specific
 * control.
 *
 * Two distinct failure modes look alike from the outside (no shell, timeout)
 * but have different causes and need different messages: SSR can render the
 * unauthenticated shell (the session lookup itself failed or timed out — the
 * session cookie is stripped by design in `e2e-worker-runtime.ts`), or the
 * authenticated shell can render but never flip its hydrated marker (bundle
 * fetch/parse/execute starved on a busy main thread). Both messages carry the
 * URL and the `get-session` status observed at the moment of failure so a
 * flake is attributable without re-running under a trace.
 */
export async function waitForAppHydration(page: Page) {
  const shell = page.locator(
    '[data-app-shell="authenticated"][data-hydrated="true"]',
  );
  const signIn = page.getByRole("link", { name: "Sign In", exact: true });

  // Only the LAST attempt's outcome matters for the message: which branch was
  // observed drives which of the two messages is thrown below. The `get-session`
  // fetch is diagnostic-only and must not run on every retry — it is real
  // network I/O, and adding it to the hot retry path would itself slow down
  // hydration under load instead of just explaining a failure that already
  // happened.
  let sawSignIn = false;
  let rateLimited = false;
  try {
    await expect(async () => {
      sawSignIn = await signIn.isVisible().catch(() => false);
      if (sawSignIn) {
        rateLimited = await page
          .getByText("Too Many Requests", { exact: true })
          .isVisible()
          .catch(() => false);
        throw new Error("SSR rendered the unauthenticated shell");
      }
      await expect(shell).toBeAttached({ timeout: 3000 });
    }).toPass({ timeout: 15000 });
  } catch {
    const sessionStatus = await observedSessionStatus(page);
    const detail = `at ${page.url()} (get-session: ${sessionStatus})`;
    throw new Error(
      sawSignIn
        ? `SSR rendered the unauthenticated shell ${detail}${rateLimited ? " (Too Many Requests)" : ""}`
        : `Shell not hydrated within budget ${detail}`,
    );
  }
}

export async function gotoAuthenticatedPage(
  page: Page,
  path: string,
  ready?: Locator,
) {
  await page.goto(path, { waitUntil: "domcontentloaded" });
  await waitForAppHydration(page);
  if (ready) await expect(ready).toBeVisible({ timeout: 15000 });
}

/** Fail with the route boundary's real technical message, not a later missing-heading timeout. */
export async function failOnRouteError(page: Page) {
  const errorHeading = page.getByRole("heading", {
    level: 2,
    name: "Something went wrong",
  });
  if (!(await errorHeading.isVisible().catch(() => false))) return;

  await page.getByRole("button", { name: "Technical Details" }).click();
  const message = await page
    .getByText("Message:", { exact: true })
    .locator("..")
    .textContent();
  throw new Error(`Route error at ${page.url()}: ${message ?? "unknown"}`);
}

/**
 * The app shell may contain deliberately scrollable workbenches, but a route
 * must never widen the document itself. Keep this assertion shared so every
 * entity-list viewport test measures the same boundary.
 */
export async function expectViewportBounded(page: Page) {
  await expect(async () => {
    const measurement = await page.evaluate(() => {
      const viewportWidth = window.innerWidth;
      const documentWidth = document.documentElement.scrollWidth;
      const bodyMargin = getComputedStyle(document.body).margin;
      const offenders = Array.from(document.querySelectorAll<HTMLElement>("*"))
        .map((element) => {
          const rect = element.getBoundingClientRect();
          return {
            tag: element.tagName.toLocaleLowerCase(),
            ariaLabel: element.getAttribute("aria-label"),
            className: element.className.toString().slice(0, 160),
            left: Math.round(rect.left),
            right: Math.round(rect.right),
            width: Math.round(rect.width),
            scrollWidth: element.scrollWidth,
          };
        })
        .filter(
          ({ left, right, scrollWidth, width }) =>
            right > viewportWidth + 1 ||
            left < -1 ||
            scrollWidth > Math.max(width, viewportWidth) + 1,
        )
        .sort((a, b) => b.right - viewportWidth - (a.right - viewportWidth))
        .slice(0, 5);
      return {
        styled: bodyMargin === "0px",
        bodyMargin,
        bounded: documentWidth <= viewportWidth,
        documentWidth,
        viewportWidth,
        offenders,
      };
    });
    expect(measurement, JSON.stringify(measurement, null, 2)).toMatchObject({
      styled: true,
      bounded: true,
    });
  }).toPass({ timeout: 15000 });
}

export async function reloadAuthenticatedPage(page: Page, ready?: Locator) {
  await page.reload({ waitUntil: "domcontentloaded" });
  await waitForAppHydration(page);
  if (ready) await expect(ready).toBeVisible({ timeout: 15000 });
}

/**
 * Wait for React to hydrate a form after SSR.
 *
 * The submit control is route-owned readiness: it proves the form has rendered
 * and React can receive the next interaction without waiting for unrelated
 * background requests to settle.
 */
export async function waitForFormHydration(page: Page) {
  await waitForAppHydration(page);
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

export async function fillInput(
  page: Page,
  placeholder: string,
  value: string,
) {
  const input = page.getByPlaceholder(placeholder);
  await expect(input).toBeVisible();
  await expect(input).toBeEnabled();
  await input.fill(value);
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
 * Edit a LIST table's inline cell: open the exact row's editor and commit
 * `value`, as ONE retried unit.
 *
 * Two separate races sit between "double-click the trigger" and "type into the
 * editor", and both look identical from the outside — the overlay is simply not
 * there:
 *
 * 1. The double-click is swallowed. While a list table swaps query keys
 *    (filter/sort/page-size change, or the table state settling right after
 *    mount) it shows the previous rows behind an `inert` body — RTable's
 *    "placeholder rows for a query being replaced are not interactive" curtain.
 *    A real click inside an `inert` subtree fires NO event, and
 *    `elementFromPoint` there returns `<body>` rather than the button, so
 *    Playwright (1.62 has no `inert` awareness anywhere in its actionability
 *    checks) sees an intercepted hit target and retries — but its hit-target
 *    check and its event dispatch are not atomic. If the curtain drops between
 *    the two, the clicks land in the void and the call reports success.
 * 2. The editor opens and then goes away before it can be filled. Observed in
 *    CI on the project rename: `openCellEditor` saw the overlay, and the very
 *    next assertion found no overlay for a full 15s, with the row and its "Edit
 *    value" trigger still mounted. Not yet reproduced in a real browser — an
 *    open editor survives a same-key refetch, a full `invalidateQueries()`, and
 *    a forced column-definition rebuild — so the trigger for it is still open.
 *
 * Opening and filling as one retried unit covers both: whatever removed the
 * editor, the next attempt reopens it against a settled table. The adapter
 * emits the trigger's semantic `dblclick` atomically: raw pointer gesture
 * behavior belongs to CellEditTrigger's unit coverage, while this helper owns
 * the editor and mutation lifecycle. Retrying is safe because nothing is
 * written until the closing `press("Enter")` — an attempt that dies earlier
 * leaves no partial edit, and a repeated identical value is a no-op commit.
 *
 * Detail pages need none of this: they are never in cell-selection mode and have
 * no transition curtain, so a single click opens the editor.
 */
export async function editListCell(
  page: Page,
  trigger: Locator,
  value: string,
) {
  await expect(async () => {
    await trigger.dispatchEvent("dblclick");
    const input = cellEditorInput(page);
    await expect(input).toBeVisible({ timeout: 2_000 });
    await expect(input).toBeEnabled({ timeout: 2_000 });
    // Bound actions too: if a table refresh detaches the editor after the
    // assertions, Playwright's default action timeout would consume the whole
    // outer retry budget and prevent the promised reopen attempt.
    await input.fill(value, { timeout: 2_000 });
    await input.press("Enter", { timeout: 2_000 });
    await expect(input).toHaveCount(0, { timeout: 10_000 });
  }).toPass({ timeout: 30_000 });
}

export function waitForEntityMutation(page: Page) {
  return page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().includes("/_serverFn/") &&
      response.ok(),
  );
}

export async function editDetailCell(
  page: Page,
  trigger: Locator,
  value: string,
) {
  const input = cellEditorInput(page);
  await expect(async () => {
    await trigger.click();
    await expect(input).toBeVisible({ timeout: 2_000 });
    await expect(input).toBeEnabled({ timeout: 2_000 });
  }).toPass({ timeout: 30_000 });

  // Retrying a save could submit the same mutation twice if the request
  // succeeded but its portaled editor was slow to close. Only opening the
  // editor is retried; the commit itself is deliberately issued once.
  await input.fill(value);
  await input.press("Enter");
  await expect(input).toHaveCount(0, { timeout: 10_000 });
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
  await waitForAppHydration(page);
  const trigger = page.getByRole("button", { name: "Search", exact: true });
  await expect(trigger).toBeEnabled();
  await trigger.click();
  const palette = page.getByRole("dialog");
  await expect(palette).toBeVisible({ timeout: 10000 });
  return palette;
}

/**
 * Find a just-created record through the global command palette and land on
 * its detail page. `/locations`, `/ingredients`, and `/inventory` no longer
 * navigate to the new record on create (the dialog just closes and the list
 * refreshes in place — see `EntityEditDialog`), so this is the addressable
 * way back to a detail URL without depending on list sort order, pagination,
 * or the active list view (gallery vs. table).
 */
async function findViaCommandPalette(page: Page, query: string, name: string) {
  const palette = await openCommandPalette(page);
  await palette.getByPlaceholder("Search or jump to a page\u2026").fill(query);
  const result = palette
    .locator("div.truncate.text-sm", { hasText: name })
    .first();
  await expect(result).toBeVisible({ timeout: 10000 });
  await result.click();
}

export async function createLocation(
  page: Page,
  name: string,
  opts: { parentName?: string; type?: string } = {},
): Promise<string> {
  // `/locations/new` is gone; locations are created in the list's dialog,
  // addressable via `?create=true` (see `CreateDialogAction`).
  await page.goto("/locations?create=true");
  await waitForFormHydration(page);
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox", { name: "Name", exact: true }).fill(name);
  if (opts.type) {
    await dialog.getByPlaceholder("Select a location type").click();
    await page.getByRole("option", { name: opts.type, exact: true }).click();
  }
  if (opts.parentName) {
    await selectComboboxItem(
      page,
      dialog.getByRole("combobox", { name: /parent location/i }),
      opts.parentName,
    );
  }
  await dialog.getByRole("button", { name: /^Create$/ }).click();
  // On success the dialog closes and the list refreshes — it does not
  // navigate to the new location's detail page.
  await expect(dialog).not.toBeVisible({ timeout: 15000 });

  await findViaCommandPalette(page, `locations:${name}`, name);
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
  await expect(page.getByRole("heading", { level: 1, name })).toBeVisible({
    timeout: 10000,
  });
  await expect(
    page.getByRole("heading", { name: "Basic Information" }),
  ).toBeVisible();
}

export async function createIngredientViaForm(page: Page, name: string) {
  // `/ingredients/new` is gone; ingredients are created in the list's
  // dialog, addressable via `?create=true` (see `CreateDialogAction`).
  await page.goto("/ingredients?create=true");
  await waitForFormHydration(page);
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox", { name: "Name", exact: true }).fill(name);
  await dialog.getByRole("button", { name: /^Create$/ }).click();
  // On success the dialog closes and the list refreshes — it does not
  // navigate to the new ingredient's detail page.
  await expect(dialog).not.toBeVisible({ timeout: 15000 });

  await findViaCommandPalette(page, `ingredients:${name}`, name);
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

  await selectComboboxItem(
    page,
    page.getByRole("combobox", { name: /ingredient/i }),
    opts.ingredientName,
  );

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
  await expect(
    page.getByRole("heading", { level: 1, name: opts.name }),
  ).toBeVisible({ timeout: 10000 });
}

/**
 * Opens the inventory list's create dialog (`?create=true`, see
 * `CreateDialogAction`) and reaches the new entry through the command palette,
 * the same shape as `createLocation` and `createIngredientViaForm`.
 */
export async function addInventory(
  page: Page,
  productName: string,
  locationName: string,
  quantity: number,
  unit: string,
) {
  await page.goto("/inventory?create=true");
  await waitForFormHydration(page);
  const dialog = page.getByRole("dialog");

  await selectComboboxItem(
    page,
    dialog.getByRole("combobox", { name: "Product", exact: true }),
    productName,
  );

  await selectComboboxItem(
    page,
    dialog.getByRole("combobox", { name: "Location", exact: true }),
    locationName,
  );

  await dialog.getByLabel("Amount Value").fill(quantity.toString());

  await dialog.getByRole("textbox", { name: "Amount Unit" }).fill(unit);

  await dialog.getByRole("button", { name: /^Create$/ }).click();
  // On success the dialog closes and the list refreshes — it does not
  // navigate to the new inventory entry's detail page.
  await expect(dialog).not.toBeVisible({ timeout: 15000 });

  await findViaCommandPalette(page, `inventory:${productName}`, productName);
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

/** The two `inspectFeed` fields a mutation leaves a trace in. */
const calendarFeedTrace = z.object({
  snapshot: z.object({ revision: z.number() }).nullable(),
  dirty: z.object({ reason: z.string() }).nullable(),
});
/** Reads `/api/v1/calendar/inspectFeed` however the spec is authenticated. */
type CalendarFeedInspector = () => Promise<object | null>;

/**
 * The feed revision once nothing is pending, to pass as `before` to
 * {@link expectCalendarFeedDirtied}. Waiting for the pending mark to clear
 * matters on a fresh durable object: its constructor marks `initialize`, and
 * that first publish must not be mistaken for the mutation under test.
 */
export async function settledCalendarFeedRevision(
  inspect: CalendarFeedInspector,
): Promise<number> {
  let revision = 0;
  await expect
    .poll(
      async () => {
        const parsed = calendarFeedTrace.safeParse(await inspect());
        if (!parsed.success) return "unreadable";
        revision = parsed.data.snapshot?.revision ?? 0;
        return parsed.data.dirty
          ? `pending: ${parsed.data.dirty.reason}`
          : "settled";
      },
      { message: "calendar feed never settled before the test began" },
    )
    .toBe("settled");
  return revision;
}

/**
 * A mutation marks the feed dirty with `reason`, and the durable object's
 * alarm republishes about two seconds later, which clears that mark. Polling
 * for the mark alone raced the alarm on a slow runner (2026-09-21: the poll
 * began after two more requests and only ever saw `dirty: null`), so accept
 * either state: the pending mark, or a snapshot revision past `before` — the
 * trace the refresh leaves behind. CI runs one worker, so with a settled
 * `before` a revision bump is this test's own mutation; locally a parallel
 * spec can bump it too, which can only make the check pass early, never fail.
 */
export async function expectCalendarFeedDirtied(
  inspect: CalendarFeedInspector,
  reason: string,
  before: number,
) {
  await expect
    .poll(async () => {
      const parsed = calendarFeedTrace.safeParse(await inspect());
      if (!parsed.success) return "unreadable";
      const { dirty, snapshot } = parsed.data;
      if (dirty?.reason === reason) return "dirty";
      if ((snapshot?.revision ?? 0) > before) return "published";
      return dirty ? `dirty: ${dirty.reason}` : "clean";
    })
    .toMatch(/^(dirty|published)$/);
}
