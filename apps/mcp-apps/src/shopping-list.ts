/**
 * MCP App for `get_shopping_list`.
 *
 * The case for rendering this in-conversation rather than linking out: you plan
 * meals in chat and then stand in a store holding a phone. Checking items off
 * in prose is miserable; a list with real checkboxes is not.
 *
 * Check state is intentionally iframe-local. The shopping list is derived from
 * meals + inventory on every call — there is nothing to persist it to, and
 * inventing a "checked" column for a list that regenerates would be a data
 * model in service of a checkbox.
 */
import type { App } from "@modelcontextprotocol/ext-apps";
import {
  bootstrap,
  cubbyLink,
  el,
  footer,
  nestedButton,
  num,
  openCubby,
  panel,
  plural,
} from "./shared";

type Status = "ok" | "short" | "missing" | "unconvertible" | "subrecipe";

/**
 * The subset of `shoppingListOut` (packages/schemas/src/meal.ts) this app
 * renders — not the full wire shape. Widen it when the UI needs more.
 */
type Contribution = {
  date: string;
  recipeName: string;
  needValue: number;
};

type Item = {
  ingredientId: string | null;
  name: string;
  basisUnit: string | null;
  needValue: number;
  haveValue: number | null;
  /** max(0, need - have) — what you actually put in the cart. */
  shortfall: number | null;
  estimatedCost: number | null;
  status: Status;
  perMeal: Contribution[];
};

type ShoppingList = {
  from: string;
  to: string;
  meals: unknown[];
  items: Item[];
  estimatedTotal: number;
  pricedItems: number;
  unexpanded: Array<{ name: string }>;
  omittedMeals: Array<{
    name: string | null;
    date: string;
    mealKind: string;
  }>;
};

/**
 * Buy-first ordering. `missing` and `short` are the actual shopping list;
 * `unconvertible` needs a human eye (no density mapping, so need vs. have can't
 * be compared); `ok` and `subrecipe` are reference.
 */
const GROUPS: Array<{
  status: Status;
  label: string;
  note: string;
  color: string;
}> = [
  {
    status: "missing",
    label: "Missing",
    note: "none on hand",
    color: "var(--destructive)",
  },
  {
    status: "short",
    label: "Short",
    note: "buy the difference",
    color: "var(--warning)",
  },
  {
    status: "unconvertible",
    label: "Check",
    note: "no unit conversion",
    color: "var(--slate)",
  },
  {
    status: "subrecipe",
    label: "Sub-recipes",
    note: "made, not bought",
    color: "var(--brand-aubergine)",
  },
  { status: "ok", label: "On hand", note: "", color: "var(--positive)" },
];

const checked = new Set<string>();

/**
 * Identity for check-off state. `ingredientId` is non-null for everything
 * `get_shopping_list` emits today (`getAggregatedNeeds` skips sub-recipes —
 * availability.service.ts), but the schema allows null, so the fallback keys off
 * the item's position in the full list rather than trusting that invariant.
 */
function itemKey(item: Item, index: number): string {
  return item.ingredientId ?? `${item.name}:${index}`;
}

/** `120 g` / `2` — the unit is null when the need had no basis. */
function amount(value: number, unit: string | null): string {
  return unit ? `${num(value)} ${unit}` : num(value);
}

function money(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

function renderDetail(app: App, item: Item): HTMLElement {
  const wrap = el("div", "detail");
  for (const c of item.perMeal) {
    const line = el("div", "detail-line");
    line.append(
      el("span", undefined, `${c.date} · ${c.recipeName}`),
      el("span", "mono", amount(c.needValue, item.basisUnit)),
    );
    wrap.append(line);
  }
  // Keeping the deep link off the row avoids competing with check-off, the
  // primary action on this phone-oriented surface.
  const { ingredientId } = item;
  if (ingredientId) {
    wrap.append(
      nestedButton("btn-link", "Open ingredient →", () =>
        openCubby(app, `/ingredients/${ingredientId}`),
      ),
    );
  }
  return wrap;
}

function renderItem(app: App, item: Item, index: number): HTMLElement {
  const key = itemKey(item, index);
  const wrap = el("div");
  const row = el("div", "row row-tappable");

  const box = el("input");
  box.type = "checkbox";
  box.checked = checked.has(key);

  const label = el("span", "row-label");
  label.append(el("span", "row-label-text", item.name));

  box.addEventListener("change", () => {
    if (box.checked) checked.add(key);
    else checked.delete(key);
    row.classList.toggle("row-checked", box.checked);
  });
  row.classList.toggle("row-checked", box.checked);

  row.append(box, label);

  // Display the buy amount first; the total remains visible for traceability.
  const isPartial = item.status === "short" && item.haveValue !== null;
  if (isPartial) {
    row.append(el("span", "mono sub", `of ${num(item.needValue)}`));
  } else if (item.haveValue !== null && item.haveValue > 0) {
    // `have 0` on a missing item restates the group header; null means no
    // conversion exists, which the "Check" group already says.
    row.append(el("span", "mono sub", `have ${num(item.haveValue)}`));
  }

  if (item.estimatedCost !== null && item.estimatedCost > 0) {
    row.append(el("span", "mono item-cost", money(item.estimatedCost)));
  }

  row.append(
    el(
      "span",
      "mono figure",
      amount(
        isPartial ? (item.shortfall ?? item.needValue) : item.needValue,
        item.basisUnit,
      ),
    ),
  );

  // The row is the mobile-friendly checkbox tap target.
  row.addEventListener("click", (event) => {
    if (event.target === box) return;
    if ((event.target as HTMLElement).closest("button")) return;
    box.checked = !box.checked;
    box.dispatchEvent(new Event("change"));
  });

  wrap.append(row);

  if (item.perMeal.length > 0) {
    const detail = renderDetail(app, item);
    detail.hidden = true;
    const toggle = nestedButton(
      "btn-eyebrow",
      plural(item.perMeal.length, "meal"),
      () => {
        detail.hidden = !detail.hidden;
        toggle.classList.toggle("btn-eyebrow-open", !detail.hidden);
      },
    );
    label.append(toggle);
    wrap.append(detail);
  }

  return wrap;
}

function render(app: App, list: ShoppingList): Node {
  const root = el("div");
  const body = panel(
    "Shopping list",
    `${list.from} → ${list.to} · ${plural(list.meals.length, "meal")}`,
  );

  const pricing = el("div", "row summary-row");
  pricing.append(el("span", "eyebrow eyebrow-ink", "Estimated trip cost"));
  const coverage = list.items.length;
  const pricedItems = list.pricedItems ?? 0;
  const estimatedTotal = list.estimatedTotal ?? 0;
  const priceText =
    pricedItems === 0
      ? "No items priced"
      : pricedItems === coverage
        ? `${money(estimatedTotal)} · all ${coverage} priced`
        : `${money(estimatedTotal)} · priced ${pricedItems} of ${coverage}`;
  pricing.append(el("span", "summary-value", priceText));
  body.append(pricing);

  const unexpanded = list.unexpanded ?? [];
  if (unexpanded.length > 0) {
    const names = [...new Set(unexpanded.map((item) => item.name))].join(", ");
    body.append(
      el(
        "p",
        "notice",
        `${plural(unexpanded.length, "sub-recipe")} could not be expanded${names ? `: ${names}` : ""}. Its ingredients are not included below.`,
      ),
    );
  }
  const omittedMeals = list.omittedMeals ?? [];
  if (omittedMeals.length > 0) {
    body.append(
      el(
        "p",
        "notice",
        `${plural(omittedMeals.length, "meal")} omitted because no shopping is needed for its meal type.`,
      ),
    );
  }

  // Positions in the full list, not per group: they feed the check-off key, and
  // a per-group index would repeat across groups.
  const indexed = list.items.map((item, index) => ({ item, index }));

  let rendered = 0;
  for (const group of GROUPS) {
    const items = indexed.filter(({ item }) => item.status === group.status);
    if (items.length === 0) continue;
    rendered += items.length;

    const head = el("div", "row row-group");
    const dot = el("span", "dot");
    dot.style.background = group.color;
    head.append(dot, el("span", "eyebrow eyebrow-ink", group.label));
    if (group.note) head.append(el("span", "eyebrow", `· ${group.note}`));
    head.append(el("span", "eyebrow push", String(items.length)));
    body.append(head);

    for (const { item, index } of items) {
      body.append(renderItem(app, item, index));
    }
  }

  if (rendered === 0) {
    body.append(el("p", "empty", "No ingredients needed in this range."));
  }

  root.append(
    body,
    footer(
      el("span", "push"),
      cubbyLink(app, "Open in Cubby", "/meals/shopping-list"),
    ),
  );
  return root;
}

export function bootstrapShoppingList(): Promise<void> {
  return bootstrap<ShoppingList>({
    name: "Cubby Shopping List",
    invalid: "Could not read the shopping list from the tool result.",
    onResult: () => {
      checked.clear();
    },
    render,
  });
}
