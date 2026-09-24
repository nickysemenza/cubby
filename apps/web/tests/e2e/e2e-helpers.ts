import { SHORTCODE_BODY_LENGTH, SHORTCODE_CHARS } from "@cubby/shared";
import {
  expect,
  type Locator,
  type Page,
  test,
  type TestInfo,
} from "@playwright/test";
import { z } from "zod";

import {
  NAVIGATION_ANNOTATION,
  NAVIGATION_PHASES_ANNOTATION,
} from "./navigation-timing";

/** A public shortcode body, for composing route and id patterns. */
export const SHORTCODE = `[${SHORTCODE_CHARS}]{${SHORTCODE_BODY_LENGTH}}`;

export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * A record name no other test can produce. A worker keeps one database for
 * every spec it runs, so which specs share it changes with the shard split; a
 * literal or faker-picked name then collides with another spec's record (a
 * strict-mode violation, or a count that includes a stranger's rows).
 */
export function uniqueName(testInfo: TestInfo, label: string): string {
  const token = [
    testInfo.testId.slice(-4),
    testInfo.repeatEachIndex.toString(36),
    testInfo.parallelIndex.toString(36),
    Date.now().toString(36).slice(-5),
  ].join("");
  return `${label} ${token}`;
}

/** Read an expense through the public API, for `expect.poll` after a UI write. */
export async function readExpense<Schema extends z.ZodType>(
  page: Page,
  id: string,
  schema: Schema,
): Promise<z.output<Schema>> {
  const response = await page.request.get(`/api/v1/expenses/${id}`);
  expect(response.ok(), `GET /api/v1/expenses/${id}`).toBe(true);
  return schema.parse(await response.json());
}

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
 * it proves shell-level click handlers are attached without coupling the wait
 * to a route-specific control.
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
  await timedNavigation(page, async () => {
    await page.goto(path, { waitUntil: "domcontentloaded" });
    await waitForAppHydration(page);
  });
  if (ready) await expect(ready).toBeVisible({ timeout: 15000 });
}

async function timedNavigation(page: Page, step: () => Promise<void>) {
  const started = performance.now();
  await step();
  test.info().annotations.push({
    type: NAVIGATION_ANNOTATION,
    description: String(Math.round(performance.now() - started)),
  });
  const phases = await page.evaluate(() => {
    const [entry] = performance.getEntriesByType("navigation");
    if (!(entry instanceof PerformanceNavigationTiming)) return null;
    return [
      entry.responseStart,
      entry.responseEnd,
      entry.domContentLoadedEventEnd,
      performance.now(),
    ].map(Math.round);
  });
  if (phases)
    test.info().annotations.push({
      type: NAVIGATION_PHASES_ANNOTATION,
      description: phases.join(","),
    });
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
            // Unrounded: a fractional overhang (right 402.4 in a 402px
            // viewport) still widens scrollWidth to 403, and rounding hid it.
            left: rect.left,
            right: rect.right,
            width: rect.width,
            scrollWidth: element.scrollWidth,
          };
        })
        .filter(
          ({ left, right, scrollWidth, width }) =>
            right > viewportWidth ||
            left < 0 ||
            scrollWidth > Math.max(Math.ceil(width), viewportWidth),
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
  await timedNavigation(page, async () => {
    await page.reload({ waitUntil: "domcontentloaded" });
    await waitForAppHydration(page);
  });
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

  // Wait for and click the option whose label is exactly itemName. An option's
  // accessible name is its label plus a description and shortcode, so match
  // the label text exactly (excluding another record whose name merely starts
  // with itemName) and anchor the name to its start (excluding the "Create new
  // <label>: <itemName>" item the popup shows while the debounced search is
  // loading — clicking it opens the quick-create dialog and wedges the form
  // behind aria-hidden).
  const option = page
    .getByRole("option", { name: new RegExp(`^${escapeRegExp(itemName)}`) })
    .filter({ has: page.getByText(itemName, { exact: true }) });
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
 * its detail page. List create dialogs do not navigate to the new record (the
 * dialog just closes and the list refreshes in place — see
 * `EntityEditDialog`), so this is the addressable way back to a detail URL
 * without depending on list sort order, pagination, or the active list view.
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

/**
 * Products are created in the list's dialog (`?create=true`, see
 * `CreateDialogAction`) — the `/products/new` page is gone. The dialog closes
 * on success without navigating, so the new product is reached through the
 * command palette.
 */
export async function createProduct(
  page: Page,
  name: string,
  opts: { manufacturer?: string } = {},
) {
  await page.goto("/products?create=true");
  await waitForFormHydration(page);
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox", { name: "Name", exact: true }).fill(name);
  if (opts.manufacturer !== undefined) {
    await dialog
      .getByRole("textbox", { name: "Manufacturer", exact: true })
      .fill(opts.manufacturer);
  }
  await dialog.getByRole("button", { name: /^Create$/ }).click();
  await expect(dialog).not.toBeVisible({ timeout: 15000 });
  await openProductFromPalette(page, name);
  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
}

/** Reach a product's detail page by name and assert its URL and heading. */
export async function openProductFromPalette(page: Page, name: string) {
  await findViaCommandPalette(page, `products:${name}`, name);
  await expect(page).toHaveURL(new RegExp(`/products/PRD-${SHORTCODE}`), {
    timeout: 15000,
  });
  await expect(page.getByRole("heading", { level: 1, name })).toBeVisible({
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
