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
  connectApp,
  el,
  mount,
  num,
  openCubby,
  renderError,
  toolPayload,
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

/** Mirrors `dataTypeLabel` in @cubby/usda-schemas. */
const TYPE_LABEL: Record<string, string> = {
  sr_legacy_food: "SR Legacy",
  survey_fndds_food: "Survey",
  foundation_food: "Foundation",
  branded_food: "Branded",
  experimental_food: "Experimental",
  agricultural_acquisition: "Agricultural",
  market_acquisition: "Market",
  sample_food: "Sample",
  sub_sample_food: "Sub-sample",
};

/**
 * The richness cue, mirroring `DATA_TYPE_PRIORITY` in @cubby/usda-schemas:
 * median nutrient count per food is SR Legacy ~85 > Survey ~65 > Foundation ~30
 * > Branded ~14. The agent can't convey "this one has real nutrient data and
 * that one is a label scan" in a flat list; a colored chip can.
 */
const TYPE_RICHNESS: Record<string, string> = {
  sr_legacy_food: "var(--positive)",
  survey_fndds_food: "var(--positive)",
  foundation_food: "var(--warning)",
  branded_food: "var(--slate)",
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
  return TYPE_LABEL[dataType] ?? dataType;
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
  const present = MACROS.filter(([code]) => nutrients[code] !== undefined);
  if (present.length === 0) return null;

  // "per 100g" is stated once in the panel header — repeating it on six cards
  // is noise, and as a flex item it wrapped to its own line.
  const strip = el("div", "mono");
  strip.style.cssText =
    "display: flex; flex-wrap: wrap; gap: 8px; font-size: 11px; color: var(--shelf);";
  for (const [code, label, unit] of present) {
    const value = nutrients[code];
    if (value === undefined) continue;
    const chip = el("span");
    const amount = el("span", "", `${num(value)}${unit}`);
    amount.style.color = "var(--ink)";
    chip.append(amount, ` ${label}`);
    strip.append(chip);
  }
  return strip;
}

function renderCard(app: App, food: Food, onPick: () => void): HTMLElement {
  const card = el("div");
  card.style.cssText =
    "border: 1px solid var(--hairline); background: var(--paper-surface); padding: 8px 10px; display: flex; flex-direction: column; gap: 6px; cursor: pointer; transition: border-color 120ms var(--ease-cozy);";

  const head = el("div");
  head.style.cssText = "display: flex; align-items: baseline; gap: 6px;";

  const badge = el("span", "badge", typeLabel(food.data_type));
  const richness = food.data_type ? TYPE_RICHNESS[food.data_type] : undefined;
  if (richness) {
    badge.style.borderColor = richness;
    badge.style.color = richness;
  }

  const title = el("span", "", food.description ?? "Untitled");
  title.style.cssText = "flex: 1; min-width: 0; font-weight: 500;";

  // The FDC id doubles as the deep link — no separate "open" button needed.
  const fdc = el("button", "mono", String(food.fdc_id));
  fdc.style.cssText =
    "flex: none; padding: 0; border: 0; background: none; font-size: 10px; color: var(--slate);";
  fdc.title = "Open in cubby";
  fdc.addEventListener("click", (event) => {
    event.stopPropagation();
    openCubby(app, `/usda/${food.fdc_id}`);
  });

  head.append(badge, title, fdc);
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
    const linked = el(
      "div",
      "eyebrow",
      `linked · ${food.linkedProducts.map((p) => p.name).join(", ")}`,
    );
    linked.style.color = "var(--ultramarine)";
    card.append(linked);
  }

  card.addEventListener("click", () => {
    selected = food;
    onPick();
    // Silent: tells the model which one is highlighted without forcing a turn.
    // `sendMessage` (the Use this button) is the one that drives the agent.
    void app.updateModelContext({
      content: [{ type: "text", text: `Selected ${describe(food)}.` }],
      structuredContent: {
        fdcId: food.fdc_id,
        description: food.description,
        dataType: food.data_type,
      },
    });
  });

  if (selected?.fdc_id === food.fdc_id) {
    card.style.borderColor = "var(--ultramarine)";
    card.style.boxShadow = "inset 3px 0 0 var(--ultramarine)";
  }

  return card;
}

function render(app: App, result: SearchResult): void {
  const root = el("div");

  const panel = el("div", "panel");
  const head = el("div", "panel-head");
  const title = el("h2", "", "USDA matches");
  title.style.fontSize = "15px";
  const total = result.meta?.totalCount;
  const count = el(
    "span",
    "eyebrow",
    `${
      total && total > result.items.length
        ? `${result.items.length} of ${total}`
        : `${result.items.length}`
    } · per 100g`,
  );
  head.append(title, count);
  panel.append(head);

  if (result.items.length === 0) {
    panel.append(el("p", "empty", "No USDA foods matched."));
    root.append(panel);
    mount(root);
    return;
  }

  const grid = el("div");
  grid.style.cssText =
    "display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 8px; padding: 10px;";
  const redraw = () => render(app, result);
  for (const food of result.items) {
    grid.append(renderCard(app, food, redraw));
  }
  panel.append(grid);
  root.append(panel);

  // One commit action, not one per card: clicking a card selects (silent
  // context update), and this is the single unambiguous "tell the agent".
  const footer = el("div");
  footer.style.cssText =
    "display: flex; align-items: center; gap: 8px; padding-top: 8px;";

  const hint = el(
    "span",
    "eyebrow",
    selected ? describe(selected) : "Select a match",
  );
  hint.style.cssText = "flex: 1; min-width: 0;";

  const browse = el("button", "btn-quiet", "Browse in cubby");
  browse.addEventListener("click", () => openCubby(app, "/usda"));

  const use = el("button", "btn", "Use this");
  use.disabled = selected === null;
  if (use.disabled) {
    use.style.cssText += "opacity: 0.4; cursor: default;";
  }
  use.addEventListener("click", () => {
    if (!selected) return;
    void app.sendMessage({
      role: "user",
      content: [{ type: "text", text: `Use ${describe(selected)}.` }],
    });
  });

  footer.append(hint, browse, use);
  root.append(footer);

  mount(root);
}

async function main(): Promise<void> {
  const app = await connectApp("Cubby USDA Picker");

  app.ontoolresult = (result) => {
    const payload = toolPayload<SearchResult>(result);
    if (!payload?.items) {
      renderError("Could not read USDA results from the tool result.");
      return;
    }
    selected = null;
    render(app, payload);
  };
}

void main();
