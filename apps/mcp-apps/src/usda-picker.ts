/**
 * MCP App for `search_usda_foods`.
 *
 * The friction this removes: the agent lists ten USDA foods and you have to say
 * "the third one, the SR Legacy one". Picking from a grid that actually shows
 * the data type and the macros is strictly better than picking from prose.
 *
 * The app deliberately does NOT perform the attach itself — it doesn't know
 * what the food is being attached to (a product? an ingredient's
 * representative? a recipe line?). It reports the choice and lets the agent,
 * which does know, carry on. That keeps the app dumb and the tool catalog flat.
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
} from "./shared";

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
  meta?: { totalCount?: number };
  items: Food[];
};

/**
 * Label + richness cue per USDA data type, mirroring `dataTypeLabel` and
 * `DATA_TYPE_PRIORITY` in @cubby/usda-schemas: median nutrient count per food is
 * SR Legacy ~85 > Survey ~65 > Foundation ~30 > Branded ~14. The agent can't
 * convey "this one has real nutrient data and that one is a label scan" in a
 * flat list; a colored chip can.
 */
const TYPES: Record<string, { label: string; color?: string }> = {
  sr_legacy_food: { label: "SR Legacy", color: "var(--positive)" },
  survey_fndds_food: { label: "Survey", color: "var(--positive)" },
  foundation_food: { label: "Foundation", color: "var(--warning)" },
  branded_food: { label: "Branded", color: "var(--slate)" },
  experimental_food: { label: "Experimental" },
  agricultural_acquisition: { label: "Agricultural" },
  market_acquisition: { label: "Market" },
  sample_food: { label: "Sample" },
  sub_sample_food: { label: "Sub-sample" },
};

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

let selected: Food | null = null;

function typeLabel(dataType: string | null): string {
  if (!dataType) return "Unknown";
  return TYPES[dataType]?.label ?? dataType;
}

/** `Butter, salted (SR Legacy, FDC 173410)` — what the agent gets told. */
function describe(food: Food): string {
  return `${food.description ?? "Untitled"} (${typeLabel(food.data_type)}, FDC ${
    food.fdc_id
  })`;
}

function renderMacros(food: Food): HTMLElement | null {
  const nutrients = food.nutrientsPer100;
  if (!nutrients) return null;
  // "per 100g" is stated once in the panel header — repeating it on six cards
  // is noise, and as a flex item it wrapped to its own line.
  const strip = el("div", "mono detail-line");
  strip.style.flexWrap = "wrap";
  strip.style.justifyContent = "flex-start";
  strip.style.fontSize = "11px";

  let any = false;
  for (const [code, label, unit] of MACROS) {
    const value = nutrients[code];
    if (value === undefined) continue;
    any = true;
    const chip = el("span");
    const figure = el("span", undefined, `${num(value)}${unit}`);
    figure.style.color = "var(--brand-foreground)";
    chip.append(figure, ` ${label}`);
    strip.append(chip);
  }
  return any ? strip : null;
}

function renderCard(app: App, food: Food, onPick: () => void): HTMLElement {
  const card = el("div", "card");
  if (selected?.fdc_id === food.fdc_id) card.classList.add("card-selected");

  const head = el("div", "card-head");

  const badge = el("span", "badge", typeLabel(food.data_type));
  const color = food.data_type ? TYPES[food.data_type]?.color : undefined;
  if (color) {
    badge.style.borderColor = color;
    badge.style.color = color;
  }

  // The FDC id doubles as the deep link — no separate "open" button needed.
  const fdc = nestedButton("btn-eyebrow", String(food.fdc_id), () =>
    openCubby(app, `/usda/${food.fdc_id}`),
  );
  fdc.title = "Open in cubby";

  head.append(badge);

  // "Already linked" outranks every other signal on the card: it means you've
  // made this call before, and picking anything else silently creates a second
  // product for one food. It gets a badge next to the data type rather than a
  // footnote under the macros.
  if (food.linkedProducts.length > 0) {
    const linked = el("span", "badge badge-accent", "linked");
    linked.title = food.linkedProducts.map((p) => p.name).join(", ");
    head.append(linked);
  }

  head.append(el("span", "card-title", food.description ?? "Untitled"), fdc);
  card.append(head);

  const brand = [food.brand_name, food.brand_owner].filter(Boolean).join(" · ");
  if (brand) {
    const line = el("div", "muted", brand);
    line.style.fontSize = "11px";
    card.append(line);
  }

  const macros = renderMacros(food);
  if (macros) card.append(macros);

  if (food.linkedProducts.length > 0) {
    const names = el(
      "div",
      "linked-names",
      food.linkedProducts.map((p) => p.name).join(", "),
    );
    card.append(names);
  }

  card.addEventListener("click", () => {
    selected = food;
    onPick();
    // Silent: tells the model which one is highlighted without forcing a turn.
    // The footer's "Use this" is what drives the agent.
    void app.updateModelContext({
      content: [{ type: "text", text: `Selected ${describe(food)}.` }],
      structuredContent: {
        fdcId: food.fdc_id,
        description: food.description,
        dataType: food.data_type,
      },
    });
  });

  return card;
}

function render(app: App, result: SearchResult): Node {
  const root = el("div");
  const total = result.meta?.totalCount;
  const shown = result.items.length;
  const body = panel(
    "USDA matches",
    `${total && total > shown ? `${shown} of ${total}` : shown} · per 100g`,
  );

  if (shown === 0) {
    body.append(el("p", "empty", "No USDA foods matched."));
    root.append(body);
    return root;
  }

  const grid = el("div", "grid");
  const redraw = () => {
    const root2 = document.getElementById("root");
    root2?.replaceChildren(render(app, result));
  };
  for (const food of result.items) {
    grid.append(renderCard(app, food, redraw));
  }
  body.append(grid);

  // One commit action, not one per card: clicking a card selects (a silent
  // context update), and this is the single unambiguous "tell the agent".
  const hint = el(
    "span",
    "eyebrow push",
    selected ? describe(selected) : "Select a match",
  );
  hint.style.flex = "1";

  const use = el("button", "btn", "Use this");
  use.disabled = selected === null;
  use.addEventListener("click", () => {
    if (!selected) return;
    void app.sendMessage({
      role: "user",
      content: [{ type: "text", text: `Use ${describe(selected)}.` }],
    });
  });

  root.append(
    body,
    footer(hint, cubbyLink(app, "Browse in cubby", "/usda"), use),
  );
  return root;
}

void bootstrap<SearchResult>({
  name: "Cubby USDA Picker",
  invalid: "Could not read USDA results from the tool result.",
  onResult: () => {
    selected = null;
  },
  render,
});
