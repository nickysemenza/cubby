/**
 * MCP App for `search_usda_foods`.
 *
 * The app keeps an ambiguous USDA choice visual and reversible: the user can
 * refine the originating query, compare evidence, select one record, and only
 * then hand that choice back to the agent. It never attaches the food itself.
 */
import type { App } from "@modelcontextprotocol/ext-apps";
import { readCubbyOrigin } from "./origin";

/**
 * The subset of `usdaFoodMcpListOut` (packages/schemas/src/mcp.ts) this app
 * renders — not the full wire shape. Widen it when the UI needs more.
 */
type Food = {
  fdc_id: number;
  description: string | null;
  data_type: string | null;
  brand_owner: string | null;
  brand_name: string | null;
  nutrientsPer100: Record<string, number> | null;
  linkedProducts: Array<{ name: string }>;
};

type SearchResult = {
  meta?: { totalCount?: number; pageSize?: number };
  items: Food[];
};

type SearchInput = {
  query?: string;
  dataType?: string;
  pageIndex?: number;
  pageSize?: number;
};

type FoodTypeDescription = { label: string; explanation: string };

const TYPES = new Map<string, FoodTypeDescription>([
  [
    "sr_legacy_food",
    {
      label: "SR Legacy",
      explanation: "Historical reference data from the final SR release.",
    },
  ],
  [
    "survey_fndds_food",
    {
      label: "Survey",
      explanation: "Food represented as people typically report eating it.",
    },
  ],
  [
    "foundation_food",
    {
      label: "Foundation",
      explanation: "Analytically sampled basic or minimally processed food.",
    },
  ],
  [
    "branded_food",
    {
      label: "Branded",
      explanation: "A specific manufacturer's label-based product record.",
    },
  ],
  [
    "experimental_food",
    {
      label: "Experimental",
      explanation: "A research record rather than an ordinary food choice.",
    },
  ],
  [
    "agricultural_acquisition",
    {
      label: "Agricultural",
      explanation: "An acquisition record from the Foundation sampling chain.",
    },
  ],
  [
    "market_acquisition",
    {
      label: "Market",
      explanation: "A market acquisition record used for sampling provenance.",
    },
  ],
  [
    "sample_food",
    {
      label: "Sample",
      explanation: "A sampling record rather than an ordinary food choice.",
    },
  ],
  [
    "sub_sample_food",
    {
      label: "Sub-sample",
      explanation: "A sampling component rather than an ordinary food choice.",
    },
  ],
]);

const FILTER_TYPES = [
  ["", "All food types"],
  ["foundation_food", "Foundation"],
  ["survey_fndds_food", "Survey / FNDDS"],
  ["sr_legacy_food", "SR Legacy"],
  ["branded_food", "Branded"],
] as const;

/**
 * USDA `nutrient_nbr` codes for the macros, mirroring `TIER1_NUTRIENTS` in
 * @cubby/usda-schemas. Copied rather than imported: that package's only export
 * is its root index, which pulls zod in, and zod's module-level schema
 * construction doesn't tree-shake out — a large dependency to inline into a
 * sandboxed iframe for four constants that have been stable for decades.
 */
const MACROS: Array<[code: string, label: string, unit: string]> = [
  ["208", "kcal", ""],
  ["203", "protein", "g"],
  ["204", "fat", "g"],
  ["205", "carbs", "g"],
];

export type UsdaPickerApp = Pick<
  App,
  | "callServerTool"
  | "connect"
  | "openLink"
  | "sendMessage"
  | "setupSizeChangedNotifications"
  | "updateModelContext"
  | "ontoolinput"
  | "ontoolresult"
>;

type PickerState = { selected: Food | null };

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function openCubby(app: UsdaPickerApp, path: string): void {
  const origin = readCubbyOrigin(document);
  if (origin) void app.openLink({ url: `${origin}${path}` });
}

function button(
  className: string,
  label: string,
  onClick: (event: MouseEvent) => void,
): HTMLButtonElement {
  const node = el("button", className, label);
  node.addEventListener("click", onClick);
  return node;
}

function nestedButton(
  className: string,
  label: string,
  onClick: () => void,
): HTMLButtonElement {
  return button(className, label, (event) => {
    event.stopPropagation();
    onClick();
  });
}

function cubbyLink(
  app: UsdaPickerApp,
  label: string,
  path: string,
): HTMLButtonElement {
  return button("btn-quiet", label, () => openCubby(app, path));
}

function panel(title: string, meta: string): HTMLElement {
  const root = el("div", "panel");
  const head = el("div", "panel-head");
  head.append(el("h2", undefined, title), el("span", "eyebrow", meta));
  root.append(head);
  return root;
}

function footer(...children: Node[]): HTMLElement {
  const root = el("div", "footer");
  root.append(...children);
  return root;
}

function isNullableString(value: unknown): value is string | null {
  return typeof value === "string" || value === null;
}

function isNumber(value: unknown): value is number {
  return typeof value === "number";
}

function isLinkedProduct(value: unknown): value is { name: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "name" in value &&
    typeof value.name === "string"
  );
}

function isNutrients(value: unknown): value is Record<string, number> | null {
  return (
    value === null ||
    (typeof value === "object" &&
      !Array.isArray(value) &&
      Object.values(value).every(isNumber))
  );
}

function isSearchMeta(value: unknown): value is SearchResult["meta"] {
  return (
    value === undefined ||
    (typeof value === "object" &&
      value !== null &&
      (!("totalCount" in value) || typeof value.totalCount === "number") &&
      (!("pageSize" in value) || typeof value.pageSize === "number"))
  );
}

function isFood(value: unknown): value is Food {
  return (
    typeof value === "object" &&
    value !== null &&
    "fdc_id" in value &&
    typeof value.fdc_id === "number" &&
    "description" in value &&
    isNullableString(value.description) &&
    "data_type" in value &&
    isNullableString(value.data_type) &&
    "brand_owner" in value &&
    isNullableString(value.brand_owner) &&
    "brand_name" in value &&
    isNullableString(value.brand_name) &&
    "nutrientsPer100" in value &&
    isNutrients(value.nutrientsPer100) &&
    "linkedProducts" in value &&
    Array.isArray(value.linkedProducts) &&
    value.linkedProducts.every(isLinkedProduct)
  );
}

function isSearchResult(value: unknown): value is SearchResult {
  return (
    typeof value === "object" &&
    value !== null &&
    "items" in value &&
    Array.isArray(value.items) &&
    value.items.every(isFood) &&
    (!("meta" in value) || isSearchMeta(value.meta))
  );
}

function isSearchInput(value: unknown): value is SearchInput {
  return (
    typeof value === "object" &&
    value !== null &&
    (!("query" in value) || typeof value.query === "string") &&
    (!("dataType" in value) || typeof value.dataType === "string") &&
    (!("pageIndex" in value) || typeof value.pageIndex === "number") &&
    (!("pageSize" in value) || typeof value.pageSize === "number")
  );
}

function toolPayload(result: {
  structuredContent?: unknown;
  content?: Array<{ type: string; text?: string }>;
}): SearchResult | null {
  if (isSearchResult(result.structuredContent)) return result.structuredContent;
  const text = result.content?.find((content) => content.type === "text")?.text;
  if (!text) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return isSearchResult(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function num(value: number): string {
  if (!Number.isFinite(value)) return "—";
  if (Number.isInteger(value)) return String(value);
  return value < 10 ? value.toFixed(1) : String(Math.round(value));
}

function typeInfo(dataType: string | null) {
  if (!dataType) {
    return { label: "Unknown", explanation: "USDA data type not provided." };
  }
  return (
    TYPES.get(dataType) ?? {
      label: dataType,
      explanation: "USDA source classification.",
    }
  );
}

function describe(food: Food): string {
  return `${food.description ?? "Untitled"} (${typeInfo(food.data_type).label}, FDC ${food.fdc_id})`;
}

function normalized(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

function matchEvidence(
  query: string,
  description: string | null,
): "Exact name" | "Starts with search" | null {
  const term = normalized(query);
  const name = normalized(description ?? "");
  if (!term || !name) return null;
  if (name === term) return "Exact name";
  if (name.startsWith(`${term} `) || name.startsWith(`${term},`)) {
    return "Starts with search";
  }
  return null;
}

function renderMacros(food: Food): HTMLElement | null {
  const nutrients = food.nutrientsPer100;
  if (!nutrients) return null;
  const strip = el("div", "mono detail-line macro-strip");
  let count = 0;
  for (const [code, label, unit] of MACROS) {
    const value = nutrients[code];
    if (value === undefined) continue;
    count += 1;
    const chip = el("span");
    chip.append(el("span", "macro-value", `${num(value)}${unit}`), ` ${label}`);
    strip.append(chip);
  }
  if (count === 0) return null;
  strip.title = `${count} of ${MACROS.length} key nutrients available per 100g`;
  return strip;
}

function renderSearchControls(
  app: UsdaPickerApp,
  result: SearchResult,
  input: SearchInput | null,
  state: PickerState,
): HTMLElement {
  const query = input?.query?.trim() ?? "";
  const wrap = el("div", "search-block");
  wrap.append(
    el(
      "p",
      "searching-for",
      query ? `Searching for “${query}”` : "Search USDA foods",
    ),
  );

  const form = el("form", "search-form");
  const field = el("input");
  field.type = "search";
  field.name = "query";
  field.value = query;
  field.placeholder = "Food name";
  field.setAttribute("aria-label", "USDA food search");

  const select = el("select");
  select.name = "dataType";
  select.setAttribute("aria-label", "USDA data type");
  for (const [value, label] of FILTER_TYPES) {
    const option = el("option", undefined, label);
    option.value = value;
    option.selected = value === (input?.dataType ?? "");
    select.append(option);
  }

  const submit = el("button", "btn", "Search");
  submit.type = "submit";
  const status = el("p", "form-status");
  status.setAttribute("aria-live", "polite");
  form.append(field, select, submit);
  wrap.append(form, status);

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const nextQuery = field.value.trim();
    if (!nextQuery) {
      field.setAttribute("aria-invalid", "true");
      status.textContent = "Enter a food name to search.";
      field.focus();
      return;
    }

    field.removeAttribute("aria-invalid");
    submit.disabled = true;
    submit.textContent = "Searching…";
    status.textContent = "Searching USDA FoodData Central…";
    const nextInput: SearchInput = {
      query: nextQuery,
      pageIndex: 0,
      pageSize: input?.pageSize ?? result.meta?.pageSize ?? 25,
    };
    if (select.value) nextInput.dataType = select.value;

    void app
      .callServerTool({ name: "search_usda_foods", arguments: nextInput })
      .then((toolResult) => {
        const next = toolPayload(toolResult);
        if (toolResult.isError || !next) {
          throw new Error("USDA search did not return usable results");
        }
        state.selected = null;
        document
          .getElementById("root")
          ?.replaceChildren(render(app, next, nextInput, state));
      })
      .catch(() => {
        submit.disabled = false;
        submit.textContent = "Search";
        status.textContent =
          "USDA search failed. Your search is still here; try again.";
      });
  });

  return wrap;
}

type RenderedFoodCard = {
  card: HTMLElement;
  radio: HTMLInputElement;
};

function renderCard(
  app: UsdaPickerApp,
  food: Food,
  query: string,
  onPick: (food: Food) => void,
  state: PickerState,
): RenderedFoodCard {
  const card = el("div", "card");
  const head = el("div", "card-head");
  const radio = el("input");
  radio.type = "radio";
  radio.name = "usda-match";
  radio.value = String(food.fdc_id);
  radio.checked = state.selected?.fdc_id === food.fdc_id;
  radio.setAttribute(
    "aria-label",
    `Select ${food.description ?? `FDC ${food.fdc_id}`}`,
  );

  const info = typeInfo(food.data_type);
  const badge = el("span", "badge", info.label);
  badge.title = info.explanation;
  const evidence = matchEvidence(query, food.description);
  head.append(radio, badge);
  if (evidence) head.append(el("span", "badge badge-neutral", evidence));
  if (food.linkedProducts.length > 0) {
    const linked = el("span", "badge badge-accent", "Linked");
    linked.title = food.linkedProducts.map((p) => p.name).join(", ");
    head.append(linked);
  }
  head.append(el("span", "card-title", food.description ?? "Untitled"));

  const fdc = nestedButton("btn-eyebrow", `FDC ${food.fdc_id}`, () =>
    openCubby(app, `/usda/${food.fdc_id}`),
  );
  fdc.title =
    "Open in Cubby. FDC IDs identify records; a higher number is not better.";
  head.append(fdc);
  card.append(head);

  const brand = [food.brand_name, food.brand_owner].filter(Boolean).join(" · ");
  if (brand) card.append(el("div", "muted card-brand", brand));

  const macros = renderMacros(food);
  if (macros) card.append(macros);
  if (food.linkedProducts.length > 0) {
    card.append(
      el(
        "div",
        "linked-names",
        food.linkedProducts.map((p) => p.name).join(", "),
      ),
    );
  }

  const pick = () => onPick(food);
  radio.addEventListener("change", pick);
  card.addEventListener("click", (event) => {
    if (
      event.target instanceof HTMLElement &&
      event.target.closest("button, input")
    )
      return;
    radio.checked = true;
    pick();
  });
  return { card, radio };
}

function render(
  app: UsdaPickerApp,
  result: SearchResult,
  input: SearchInput | null,
  state: PickerState,
): Node {
  const root = el("div");
  const total = result.meta?.totalCount;
  const shown = result.items.length;
  const body = panel(
    "USDA matches",
    `${total && total > shown ? `${shown} of ${total}` : shown} · per 100g`,
  );
  body.append(renderSearchControls(app, result, input, state));

  const query = input?.query ?? "";
  const hint = el(
    "span",
    "eyebrow selection-hint",
    state.selected ? describe(state.selected) : "Select a match",
  );
  const use = el("button", "btn", "Use this");
  use.disabled = state.selected === null;
  const controls: Array<{
    food: Food;
    card: HTMLElement;
    radio: HTMLInputElement;
  }> = [];

  const applySelection = (food: Food) => {
    state.selected = food;
    for (const control of controls) {
      const isSelected = control.food.fdc_id === food.fdc_id;
      control.radio.checked = isSelected;
      control.card.classList.toggle("card-selected", isSelected);
    }
    hint.textContent = describe(food);
    use.disabled = false;
    void app.updateModelContext({
      content: [{ type: "text", text: `Selected ${describe(food)}.` }],
      structuredContent: {
        fdcId: food.fdc_id,
        description: food.description,
        dataType: food.data_type,
      },
    });
  };

  if (shown === 0) {
    body.append(el("p", "empty", "No USDA foods matched this search."));
  } else {
    const grid = el("div", "grid");
    grid.setAttribute("role", "radiogroup");
    grid.setAttribute("aria-label", "USDA food matches");
    for (const food of result.items) {
      const control = renderCard(app, food, query, applySelection, state);
      controls.push({ food, ...control });
      grid.append(control.card);
    }
    body.append(grid);
  }

  use.addEventListener("click", () => {
    if (!state.selected) return;
    const choice = state.selected;
    void app.sendMessage({
      role: "user",
      content: [{ type: "text", text: `Use ${describe(choice)}.` }],
    });
  });

  root.append(
    body,
    footer(hint, cubbyLink(app, "Browse in Cubby", "/usda"), use),
  );
  return root;
}

export async function connectUsdaPicker(app: UsdaPickerApp): Promise<void> {
  let input: SearchInput | null = null;
  let payload: SearchResult | null = null;
  const state: PickerState = { selected: null };
  const mount = () => {
    if (!payload) return;
    document
      .getElementById("root")
      ?.replaceChildren(render(app, payload, input, state));
  };

  // The host may push input/result immediately after initialization. Register
  // both handlers before connecting so a fast host cannot race past them.
  app.ontoolinput = (notification) => {
    input = isSearchInput(notification.arguments)
      ? notification.arguments
      : null;
    mount();
  };
  app.ontoolresult = (result) => {
    const next = toolPayload(result);
    const root = document.getElementById("root");
    if (!root) return;
    if (!next) {
      root.replaceChildren(
        el("p", "empty", "Could not read USDA results from the tool result."),
      );
      return;
    }
    state.selected = null;
    payload = next;
    mount();
  };

  await app.connect();
  app.setupSizeChangedNotifications();
}
