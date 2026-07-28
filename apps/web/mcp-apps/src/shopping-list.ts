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
  connectApp,
  el,
  mount,
  num,
  openCubby,
  renderError,
  toolPayload,
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
  shortfall: number;
  status: Status;
  perMeal: Contribution[];
};

type ShoppingList = {
  from: string;
  to: string;
  meals: unknown[];
  items: Item[];
};

/**
 * Buy-first ordering. `missing` and `short` are the actual shopping list;
 * `unconvertible` needs a human eye (no density mapping, so need vs. have can't
 * be compared); `ok` and `subrecipe` are reference.
 */
const GROUPS: Array<{ status: Status; label: string; note: string }> = [
  { status: "missing", label: "Missing", note: "none on hand" },
  { status: "short", label: "Short", note: "buy the difference" },
  { status: "unconvertible", label: "Check", note: "no unit conversion" },
  { status: "subrecipe", label: "Sub-recipes", note: "made, not bought" },
  { status: "ok", label: "On hand", note: "" },
];

const STATUS_COLOR: Record<Status, string> = {
  missing: "var(--destructive)",
  short: "var(--warning)",
  unconvertible: "var(--slate)",
  subrecipe: "var(--aubergine)",
  ok: "var(--positive)",
};

const checked = new Set<string>();

function itemKey(item: Item, index: number): string {
  return item.ingredientId ?? `${item.name}:${index}`;
}

/** `120 g` / `2 each` — the unit is null when the need had no basis. */
function amount(value: number, unit: string | null): string {
  return unit ? `${num(value)} ${unit}` : num(value);
}

function renderContributions(app: App, item: Item): HTMLElement {
  const wrap = el("div");
  wrap.style.cssText =
    "padding: 5px 10px 7px 32px; background: var(--paper-alt); border-bottom: 1px solid var(--hairline);";
  for (const c of item.perMeal) {
    const line = el("div");
    line.style.cssText =
      "display: flex; gap: 8px; justify-content: space-between; color: var(--shelf);";
    line.append(
      el("span", "", `${c.date} · ${c.recipeName}`),
      el("span", "mono", amount(c.needValue, item.basisUnit)),
    );
    wrap.append(line);
  }
  // The deep link lives here rather than on the row: on the row it competes
  // with check-off, which is the whole point of the surface.
  if (item.ingredientId) {
    const link = el("button", "", "Open ingredient →");
    link.style.cssText =
      "margin-top: 4px; padding: 0; border: 0; background: none; color: var(--ultramarine); font-size: 11px;";
    link.addEventListener("click", (event) => {
      event.stopPropagation();
      openCubby(app, `/ingredients/${item.ingredientId}`);
    });
    wrap.append(link);
  }
  return wrap;
}

function renderItem(app: App, item: Item, index: number): HTMLElement {
  const key = itemKey(item, index);
  const wrap = el("div");

  const row = el("div", "row");

  const box = el("input") as HTMLInputElement;
  box.type = "checkbox";
  box.checked = checked.has(key);
  box.style.cssText =
    "accent-color: var(--ultramarine); flex: none; margin: 0;";
  box.addEventListener("change", () => {
    if (box.checked) checked.add(key);
    else checked.delete(key);
    applyChecked(row, name, box.checked);
  });

  const name = el("span", "", item.name);
  name.style.cssText = "min-width: 0;";

  // Disclosure sits beside the name, not in the numeric column, so a count of
  // meals never reads as a quantity of food.
  const label = el("span");
  label.style.cssText =
    "flex: 1; min-width: 0; display: flex; align-items: baseline; gap: 6px;";
  label.append(name);
  applyChecked(row, name, box.checked);

  row.append(box, label);

  // A partially-stocked item shows the shortfall, not the total need — "buy the
  // difference" shouldn't require mental arithmetic in a store aisle. The full
  // need stays beside it so the number is still traceable.
  const isPartial = item.status === "short" && item.haveValue !== null;
  if (isPartial) {
    const of = el("span", "mono", `of ${num(item.needValue)}`);
    of.style.cssText = "flex: none; color: var(--shelf); font-size: 11px;";
    row.append(of);
  }

  const primary = el(
    "span",
    "mono",
    amount(isPartial ? item.shortfall : item.needValue, item.basisUnit),
  );
  primary.style.cssText = "flex: none;";
  row.append(primary);

  // The whole row toggles — a 14px checkbox is a poor tap target on the phone
  // this is actually used on.
  row.addEventListener("click", (event) => {
    if (event.target === box) return;
    if ((event.target as HTMLElement).closest("button")) return;
    box.checked = !box.checked;
    box.dispatchEvent(new Event("change"));
  });
  row.style.cursor = "pointer";

  wrap.append(row);

  if (item.perMeal.length > 0) {
    const detail = renderContributions(app, item);
    detail.hidden = true;
    const toggle = el(
      "button",
      "",
      `${item.perMeal.length} ${item.perMeal.length === 1 ? "meal" : "meals"}`,
    );
    toggle.style.cssText =
      "flex: none; padding: 0; border: 0; background: none; font-family: var(--font-mono); font-size: 10px; color: var(--slate); text-transform: uppercase; letter-spacing: 0.06em;";
    toggle.addEventListener("click", () => {
      detail.hidden = !detail.hidden;
      toggle.style.color = detail.hidden
        ? "var(--slate)"
        : "var(--ultramarine)";
    });
    label.append(toggle);
    wrap.append(detail);
  }

  return wrap;
}

function applyChecked(
  row: HTMLElement,
  name: HTMLElement,
  isChecked: boolean,
): void {
  name.style.textDecoration = isChecked ? "line-through" : "none";
  row.style.opacity = isChecked ? "0.45" : "1";
}

function render(app: App, list: ShoppingList): void {
  const root = el("div");

  const panel = el("div", "panel");
  const head = el("div", "panel-head");
  const title = el("h2", "", "Shopping list");
  title.style.fontSize = "15px";
  const range = el(
    "span",
    "eyebrow",
    `${list.from} → ${list.to} · ${list.meals.length} ${
      list.meals.length === 1 ? "meal" : "meals"
    }`,
  );
  head.append(title, range);
  panel.append(head);

  let rendered = 0;
  for (const group of GROUPS) {
    const items = list.items.filter((item) => item.status === group.status);
    if (items.length === 0) continue;
    rendered += items.length;

    const groupHead = el("div", "row");
    groupHead.style.cssText =
      "padding: 6px 10px; background: var(--paper-alt); gap: 6px;";
    const dot = el("span");
    dot.style.cssText = `flex: none; width: 6px; height: 6px; background: ${
      STATUS_COLOR[group.status]
    };`;
    const label = el("span", "eyebrow", group.label);
    label.style.color = "var(--ink)";
    const count = el("span", "eyebrow", String(items.length));
    count.style.marginLeft = "auto";
    groupHead.append(dot, label);
    if (group.note) {
      groupHead.append(el("span", "eyebrow", `· ${group.note}`));
    }
    groupHead.append(count);
    panel.append(groupHead);

    for (const [index, item] of items.entries()) {
      panel.append(renderItem(app, item, index));
    }
  }

  if (rendered === 0) {
    panel.append(el("p", "empty", "No ingredients needed in this range."));
  }

  root.append(panel);

  const footer = el("div");
  footer.style.cssText =
    "display: flex; justify-content: flex-end; padding-top: 8px;";
  const full = el("button", "btn-quiet", "Open in cubby");
  full.addEventListener("click", () => openCubby(app, "/meals/shopping-list"));
  footer.append(full);
  root.append(footer);

  mount(root);
}

async function main(): Promise<void> {
  const app = await connectApp("Cubby Shopping List");

  app.ontoolresult = (result) => {
    const list = toolPayload<ShoppingList>(result);
    if (!list) {
      renderError("Could not read the shopping list from the tool result.");
      return;
    }
    render(app, list);
  };
}

void main();
