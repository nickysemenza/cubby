use std::{collections::HashSet, str::FromStr};

use ingredient::{
    from_str as parse_ingredient_str,
    ingredient::Ingredient,
    rich_text::{Chunk, RichParser},
    unit::{
        convert_measure_with_graph, find_connected_components, is_valid, make_graph, print_graph,
        Measure, MeasureKind,
    },
    unit_mapping::{parse_unit_mapping as parse_unit_mapping_internal, ParsedUnitMapping},
    util::truncate_3_decimals,
};
use recipe_scraper::{RecipeSection, RecipeYield, ScrapedRecipe};
use serde::{Deserialize, Serialize};
use tsify_next::Tsify;
use wasm_bindgen::prelude::*;

// WASM initialization - called automatically when module loads
#[wasm_bindgen(start)]
pub fn init() {
    console_error_panic_hook::set_once();
    let mut config = wasm_tracing::WasmLayerConfig::new();
    config.set_max_level(tracing::Level::INFO);
    let _ = wasm_tracing::set_as_global_default_with_config(config);
}

// A pair of measures that can be used for unit conversion
type UnitMappingPairs = Vec<(Measure, Measure)>;

// Boundary types: `#[derive(Tsify)]` generates the `.d.ts` from these structs
// (no hand-written `typescript_custom_section`), and the `From<upstream>` impls
// are the compile-time drift check against ingredient-parser. The two types that
// can't be derived stay hand-authored below.

/// A measurement value + unit (mirrors `Measure`).
#[derive(Tsify, Serialize, Deserialize)]
#[tsify(into_wasm_abi, from_wasm_abi)]
pub struct WAmount {
    pub unit: String,
    pub value: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub upper_value: Option<f64>,
}

impl WAmount {
    fn to_measure(&self) -> Measure {
        match self.upper_value {
            Some(upper) => Measure::with_range(&self.unit, self.value, upper),
            None => Measure::new(&self.unit, self.value),
        }
    }
}

impl From<&Measure> for WAmount {
    fn from(m: &Measure) -> Self {
        Self {
            // `unit().to_str()` (canonical/singular, matching serde) — NOT
            // `unit_as_string()`, which pluralizes for display.
            unit: m.unit().to_str(),
            value: m.value(),
            upper_value: m.upper_value(),
        }
    }
}

impl From<Measure> for WAmount {
    fn from(m: Measure) -> Self {
        Self::from(&m)
    }
}

/// One nutrient target's conversion (e.g. "g protein"), or null when no path
/// exists. A Vec (not a map) so tsify derives the boundary type cleanly —
/// serde_wasm_bindgen serializes a HashMap as an ES Map, not an object.
#[derive(Tsify, Serialize, Deserialize)]
#[tsify(into_wasm_abi)]
pub struct WNutrientConversion {
    pub target: String,
    pub amount: Option<WAmount>,
}

/// One entry per requested nutrient target (the return of
/// `conv_amount_to_nutrients`). Transparent newtype so a bare list can cross the
/// wasm boundary as `WNutrientConversion[]` (same pattern as `WCookbookChunks`).
#[derive(Tsify, Serialize, Deserialize)]
#[tsify(into_wasm_abi)]
#[serde(transparent)]
pub struct WNutrientConversions(pub Vec<WNutrientConversion>);

/// Every costing measure for one amount, from a single `conv_amount_all` call.
/// Each field is the converted amount, or null when no conversion path exists.
#[derive(Tsify, Serialize, Deserialize)]
#[tsify(into_wasm_abi)]
pub struct WAmountAll {
    pub money: Option<WAmount>,
    pub weight: Option<WAmount>,
    pub calories: Option<WAmount>,
    pub nutrients: Vec<WNutrientConversion>,
}

/// A parsed ingredient (mirrors `Ingredient`).
#[derive(Tsify, Serialize, Deserialize)]
#[tsify(into_wasm_abi)]
pub struct WIngredient {
    pub name: String,
    pub amounts: Vec<WAmount>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub modifier: Option<String>,
}

impl From<Ingredient> for WIngredient {
    fn from(i: Ingredient) -> Self {
        Self {
            name: i.name,
            amounts: i.amounts.iter().map(WAmount::from).collect(),
            modifier: i.modifier,
        }
    }
}

/// A unit-conversion pair (mirrors `ParsedUnitMapping`).
#[derive(Tsify, Serialize, Deserialize)]
#[tsify(into_wasm_abi, from_wasm_abi)]
pub struct WUnitMapping {
    pub a: WAmount,
    pub b: WAmount,
    // `string | null`, not `string`: callers pass DB rows with a nullable
    // `source` column (serde maps a JSON `null` to `None`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[tsify(optional, type = "string | null")]
    pub source: Option<String>,
}

impl WUnitMapping {
    fn to_pair(&self) -> (Measure, Measure) {
        (self.a.to_measure(), self.b.to_measure())
    }
}

impl From<ParsedUnitMapping> for WUnitMapping {
    fn from(p: ParsedUnitMapping) -> Self {
        Self {
            a: WAmount::from(&p.a),
            b: WAmount::from(&p.b),
            source: p.source,
        }
    }
}

/// `WUnitMapping[]` as a single wasm arg (wasm-bindgen can't take a bare
/// `Vec<TsifyStruct>` parameter); `transparent` → `type WUnitMappings = WUnitMapping[]`.
#[derive(Tsify, Serialize, Deserialize)]
#[tsify(from_wasm_abi)]
#[serde(transparent)]
pub struct WUnitMappings(pub Vec<WUnitMapping>);

impl WUnitMappings {
    fn to_pairs(&self) -> UnitMappingPairs {
        self.0.iter().map(WUnitMapping::to_pair).collect()
    }
}

/// Structured yield, e.g. `{ value: 12, unit: "pancakes" }`.
#[derive(Tsify, Serialize, Deserialize)]
pub struct WRecipeYield {
    pub value: f64,
    pub unit: String,
}

impl From<RecipeYield> for WRecipeYield {
    fn from(y: RecipeYield) -> Self {
        Self {
            value: y.value,
            unit: y.unit,
        }
    }
}

/// Result of parsing a freeform yield string into structured yield + servings.
#[derive(Tsify, Serialize, Deserialize)]
#[tsify(into_wasm_abi)]
pub struct WYieldResult {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recipe_yield: Option<WRecipeYield>,
    /// Servings as integer (extracted from yield if unit is "serving(s)").
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub servings: Option<u32>,
}

/// A recipe component with raw ingredient/instruction lines (mirrors `RecipeSection`).
#[derive(Tsify, Serialize, Deserialize)]
pub struct WRecipeSection {
    /// Component label (e.g., "For the sauce"); absent for the main/only section.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub ingredients: Vec<String>,
    pub instructions: Vec<String>,
}

impl From<RecipeSection> for WRecipeSection {
    fn from(s: RecipeSection) -> Self {
        Self {
            name: s.name,
            ingredients: s.ingredients,
            instructions: s.instructions,
        }
    }
}

/// A scraped recipe (the cubby-facing subset of `ScrapedRecipe`).
#[derive(Tsify, Serialize, Deserialize)]
#[tsify(into_wasm_abi)]
pub struct WCompactRecipe {
    /// Recipe components; most recipes have a single unnamed section.
    pub sections: Vec<WRecipeSection>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image: Option<String>,
    /// Parsed yield (e.g., `{ value: 12, unit: "pancakes" }`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recipe_yield: Option<WRecipeYield>,
    /// Servings as integer (extracted from yield if unit is "serving(s)").
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub servings: Option<u32>,
}

impl From<ScrapedRecipe> for WCompactRecipe {
    fn from(r: ScrapedRecipe) -> Self {
        Self {
            sections: r.sections.into_iter().map(WRecipeSection::from).collect(),
            name: Some(r.name),
            url: Some(r.url),
            image: r.image,
            recipe_yield: r.recipe_yield.map(WRecipeYield::from),
            servings: r.servings,
        }
    }
}

/// One span of measurement-aware instruction text (mirrors `Chunk`).
#[derive(Tsify, Serialize, Deserialize)]
#[serde(tag = "kind", content = "value")]
pub enum RichItem {
    Text(String),
    Ing(String),
    Measure(Vec<WAmount>),
}

impl From<Chunk> for RichItem {
    fn from(c: Chunk) -> Self {
        match c {
            Chunk::Text(t) => RichItem::Text(t),
            Chunk::Ing(i) => RichItem::Ing(i),
            Chunk::Measure(ms) => RichItem::Measure(ms.iter().map(WAmount::from).collect()),
        }
    }
}

/// `RichItem[]` (`transparent` → `type RichItems = RichItem[]`).
#[derive(Tsify, Serialize, Deserialize)]
#[tsify(into_wasm_abi)]
#[serde(transparent)]
pub struct RichItems(pub Vec<RichItem>);

// Hand-authored boundary type that can't be derived: `AmountKind`, a
// `nutrient:${string}` template-literal union.
#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(typescript_type = "AmountKind")]
    pub type WAmountKind;
}

#[wasm_bindgen(typescript_custom_section)]
const HAND_AUTHORED_TS: &str = r#"
type AmountKind = "weight" | "volume" | "money" | "calories" | "time" | "temperature" | "length" | "other" | `nutrient:${string}`;
"#;

// serde boundary: AmountKind input + the islands array (`to_js`).
fn from_js<T: for<'de> Deserialize<'de>>(v: impl Into<JsValue>, ctx: &str) -> Result<T, String> {
    serde_wasm_bindgen::from_value(v.into()).map_err(|e| format!("Failed to parse {ctx}: {e}"))
}

fn to_js<T: Serialize>(v: &T, ctx: &str) -> Result<JsValue, String> {
    serde_wasm_bindgen::to_value(v).map_err(|e| format!("Failed to serialize {ctx}: {e}"))
}

// Public API

#[wasm_bindgen]
pub fn format_amount_value(input: WAmount) -> f64 {
    truncate_3_decimals(input.value)
}

#[wasm_bindgen]
pub fn parse_ingredient(input: &str) -> WIngredient {
    parse_ingredient_str(input).into()
}

#[wasm_bindgen]
pub fn format_amount(amount: WAmount) -> String {
    amount.to_measure().to_string()
}

#[wasm_bindgen]
pub fn graph_unit_mappings(mappings: WUnitMappings) -> String {
    print_graph(make_graph(&mappings.to_pairs()))
}

/// Detect disconnected components (islands) in the unit-mapping graph. Returns a
/// list of component groups, where each group is a list of unit strings.
#[wasm_bindgen]
pub fn detect_unit_mapping_islands(mappings: WUnitMappings) -> Result<JsValue, String> {
    let graph = make_graph(&mappings.to_pairs());
    let components = find_connected_components(&graph);
    to_js(&components, "connected components")
}

#[wasm_bindgen]
pub fn conv_amount_to_kind(
    mappings: WUnitMappings,
    target_kind_w: WAmountKind,
    amount_w: WAmount,
) -> Result<WAmount, String> {
    let pairs = mappings.to_pairs();
    let measure = amount_w.to_measure();
    let kind_str: String = from_js(target_kind_w, "amount kind")?;
    let kind =
        MeasureKind::from_str(&kind_str).map_err(|_| format!("Invalid amount kind: {kind_str}"))?;

    measure
        .convert_measure_via_mappings(kind.clone(), &pairs)
        .ok_or_else(|| format!("Failed to convert '{measure}' to '{kind}'"))
        .map(WAmount::from)
}

/// Convert an amount to multiple nutrient targets in a single call (graph built
/// once). Returns one entry per target — the converted amount, or null when no
/// conversion path exists.
#[wasm_bindgen]
pub fn conv_amount_to_nutrients(
    mappings: WUnitMappings,
    nutrient_targets: Vec<String>, // ["g protein", "mg sodium", "kcal kcal"]
    amount_w: WAmount,
) -> WNutrientConversions {
    let measure = amount_w.to_measure();
    let graph = make_graph(&mappings.to_pairs());
    WNutrientConversions(
        nutrient_targets
            .into_iter()
            .map(|target| WNutrientConversion {
                amount: convert_measure_with_graph(
                    &measure,
                    MeasureKind::Nutrient(target.clone()),
                    &graph,
                )
                .map(WAmount::from),
                target,
            })
            .collect(),
    )
}

/// Convert an amount to every costing measure (money, weight, calories, and each
/// nutrient target) in a single call, building the unit-mapping graph ONCE and
/// reusing it for all conversions. Collapses the recipe-costing hot path's
/// per-ingredient fan-out (money + weight + nutrients + calories = 4 boundary
/// crossings, each rebuilding the graph) into one. Each field is the converted
/// `WAmount`, or null when no conversion path exists.
#[wasm_bindgen]
pub fn conv_amount_all(
    mappings: WUnitMappings,
    nutrient_targets: Vec<String>, // non-kcal targets, e.g. ["g protein", "mg sodium"]
    amount_w: WAmount,
) -> WAmountAll {
    let measure = amount_w.to_measure();
    let graph = make_graph(&mappings.to_pairs()); // built ONCE, reused below
    let convert =
        |kind: MeasureKind| convert_measure_with_graph(&measure, kind, &graph).map(WAmount::from);

    WAmountAll {
        money: convert(MeasureKind::Money),
        weight: convert(MeasureKind::Weight),
        calories: convert(MeasureKind::Calories),
        nutrients: nutrient_targets
            .into_iter()
            .map(|target| WNutrientConversion {
                amount: convert(MeasureKind::Nutrient(target.clone())),
                target,
            })
            .collect(),
    }
}

/// Convert an amount to a specific unit target (e.g., "g protein").
#[wasm_bindgen]
pub fn conv_amount_to_unit(
    mappings: WUnitMappings,
    target_unit: String,
    amount_w: WAmount,
) -> Result<WAmount, String> {
    let pairs = mappings.to_pairs();
    let measure = amount_w.to_measure();
    let kind = MeasureKind::Nutrient(target_unit.clone());

    measure
        .convert_measure_via_mappings(kind, &pairs)
        .ok_or_else(|| format!("Failed to convert to '{target_unit}'"))
        .map(WAmount::from)
}

#[wasm_bindgen]
pub fn parse_scraped_recipe(body: &str, url: &str) -> Result<WCompactRecipe, String> {
    recipe_scraper::scrape(body, url)
        .map_err(|e| format!("Failed to scrape: {e}"))
        .map(WCompactRecipe::from)
}

/// Parse a freeform yield string ("Makes about 12 pancakes", "Serves 4") into a
/// structured `{ recipe_yield?, servings? }`, using the same parser the web
/// scraper uses for JSON-LD yields (so cookbook and web yields stay consistent).
#[wasm_bindgen]
pub fn parse_yield(input: &str) -> WYieldResult {
    let (recipe_yield, servings) = recipe_scraper::parse_yield_string(input);
    WYieldResult {
        recipe_yield: recipe_yield.map(WRecipeYield::from),
        servings,
    }
}

#[wasm_bindgen]
pub fn parse_rich_text(text: String, ingredient_names: Vec<String>) -> Result<RichItems, String> {
    RichParser::new(ingredient_names)
        .parse(&text)
        .map_err(|e| e.to_string())
        .map(|chunks| RichItems(chunks.into_iter().map(RichItem::from).collect()))
}

#[wasm_bindgen]
pub fn is_valid_unit(unit: &str, extra_units: Vec<String>) -> bool {
    is_valid(&HashSet::from_iter(extra_units), unit)
}

#[wasm_bindgen]
pub fn amount_kind(amount: WAmount) -> Result<WAmountKind, String> {
    amount
        .to_measure()
        .kind()
        .map_err(|_| "Unknown unit kind".to_string())
        .and_then(|k| to_js(&k.to_str(), "amount kind").map(Into::into))
}

/// Parse a unit mapping string in multiple formats:
/// - "4 lb = $5" (conversion format)
/// - "$5/4lb" (price-per format)
/// - "4 lb = $5 @ costco" (with source)
#[wasm_bindgen]
pub fn parse_unit_mapping(input: String) -> Result<WUnitMapping, String> {
    Ok(parse_unit_mapping_internal(&input)?.into())
}

// ===========================================================================
// EPUB cookbook extraction (client-side pipeline; LLM call proxied via Cubby)
//
// The browser drives the loop: `chunk_epub` splits an uploaded .epub into text
// chunks each carrying a ready-to-send LLM request; the orchestrator sends each
// request to Cubby's `extractCookbookChunk` proxy (which holds the gateway key);
// `assemble_recipes` folds the per-chunk model outputs back into recipes. All
// recipe logic stays in Rust — TS only moves bytes.
// ===========================================================================

use recipe_epub::{
    assemble_recipes as assemble_recipes_internal, build_chunk_request,
    chunk_epub as chunk_epub_internal, parse_recipes_payload, Chunk as EpubChunk, Link as EpubLink,
};
use sha2::{Digest, Sha256};

/// One LLM request for a cookbook chunk (mirrors `recipe_epub::ChunkRequest`).
/// Sent verbatim to Cubby's `extractCookbookChunk` proxy.
#[derive(Tsify, Serialize, Deserialize)]
#[tsify(into_wasm_abi, from_wasm_abi)]
pub struct WChunkRequest {
    pub system: String,
    pub user: String,
    pub tool_name: String,
    /// JSON Schema for the forced tool's input, as a JSON **string** — serde
    /// would otherwise marshal a `serde_json::Value` object across the wasm
    /// boundary as a JS `Map` (breaks `JSON.stringify` + tRPC validation). The
    /// orchestrator `JSON.parse`s it once before sending.
    pub tool_schema: String,
}

/// An internal EPUB hyperlink (mirrors `recipe_epub::Link`).
#[derive(Tsify, Serialize, Deserialize)]
#[tsify(into_wasm_abi, from_wasm_abi)]
pub struct WCookbookLink {
    pub text: String,
    pub href: String,
}

/// A unit of cookbook text to extract: a stable `id` (sha256 of the text, for
/// the orchestrator's session cache), provenance, and the ready-to-send request.
/// `assemble_recipes` consumes the same chunks back, paired with model output.
#[derive(Tsify, Serialize, Deserialize)]
#[tsify(into_wasm_abi, from_wasm_abi)]
pub struct WCookbookChunk {
    pub id: String,
    pub doc_path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[tsify(optional)]
    pub title_hint: Option<String>,
    pub links: Vec<WCookbookLink>,
    pub request: WChunkRequest,
}

/// `WCookbookChunk[]` (`transparent`).
#[derive(Tsify, Serialize, Deserialize)]
#[tsify(into_wasm_abi, from_wasm_abi)]
#[serde(transparent)]
pub struct WCookbookChunks(pub Vec<WCookbookChunk>);

/// The model's output for one chunk: the `id` it answers, plus the raw forced-
/// tool `input` object (`{ recipes: [...] }`) the proxy returned.
#[derive(Tsify, Serialize, Deserialize)]
#[tsify(into_wasm_abi, from_wasm_abi)]
pub struct WChunkResult {
    pub id: String,
    /// The forced tool's `input` object as returned by the LLM proxy.
    #[tsify(type = "unknown")]
    pub input: serde_json::Value,
}

/// `WChunkResult[]` (`transparent`).
#[derive(Tsify, Serialize, Deserialize)]
#[tsify(into_wasm_abi, from_wasm_abi)]
#[serde(transparent)]
pub struct WChunkResults(pub Vec<WChunkResult>);

/// Phase 1: unzip the EPUB and split it into text chunks, each carrying its
/// ready-to-send LLM request. Pure — no network, no filesystem.
#[wasm_bindgen]
pub fn chunk_epub(bytes: &[u8]) -> Result<WCookbookChunks, String> {
    let chunks = chunk_epub_internal(bytes).map_err(|e| e.to_string())?;
    let out = chunks
        .into_iter()
        .map(|c| {
            let req = build_chunk_request(&c);
            // Stable id over the chunk text → the orchestrator's session-cache
            // key (don't re-pay an already-extracted chunk on a retry).
            let id = Sha256::digest(c.text.as_bytes())
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect::<String>();
            WCookbookChunk {
                id,
                doc_path: c.doc_path,
                title_hint: c.title_hint,
                links: c
                    .links
                    .into_iter()
                    .map(|l| WCookbookLink {
                        text: l.text,
                        href: l.href,
                    })
                    .collect(),
                request: WChunkRequest {
                    system: req.system,
                    user: req.user,
                    tool_name: req.tool_name,
                    tool_schema: serde_json::to_string(&req.tool_schema)
                        .unwrap_or_else(|_| "{}".to_string()),
                },
            }
        })
        .collect();
    Ok(WCookbookChunks(out))
}

/// Phase 2: fold the per-chunk model outputs into final recipes and resolve
/// cross-recipe references. `chunks` is the same array `chunk_epub` returned;
/// `results` pairs each chunk `id` with the model's raw tool output. Returns
/// `CookbookRecipe[]` (validate with `cookbookRecipesSchema` on the TS side).
#[wasm_bindgen]
pub fn assemble_recipes(
    chunks: WCookbookChunks,
    results: WChunkResults,
    source: String,
) -> Result<JsValue, String> {
    let mut by_id: std::collections::HashMap<String, serde_json::Value> =
        results.0.into_iter().map(|r| (r.id, r.input)).collect();
    let mut per_chunk = Vec::with_capacity(chunks.0.len());
    let mut links: Vec<EpubLink> = Vec::new();
    for c in chunks.0 {
        let recipes = match by_id.remove(&c.id) {
            Some(input) => parse_recipes_payload(input).map_err(|e| e.to_string())?,
            None => Vec::new(),
        };
        let chunk_links: Vec<EpubLink> = c
            .links
            .into_iter()
            .map(|l| EpubLink {
                text: l.text,
                href: l.href,
            })
            .collect();
        links.extend(chunk_links.iter().cloned());
        // `assemble_recipes` takes the full `Chunk` so it can bind each recipe's
        // hero photo (`hero_for` uses `text` + `images`). We deliberately pass empty
        // `text`/`images`, leaving the resulting `CookbookRecipe.image` = None.
        //
        // TODO(hero-photos): wire EPUB hero photos to the UI. recipe-epub already
        // computes a per-recipe `ImageRef` (an in-archive path + MIME, not bytes).
        // To use it we'd need to: (1) carry `text` + the `(line, ImageRef)` images
        // back across this boundary (re-add `text`/`images` to `WCookbookChunk` +
        // `WImageRef`), (2) materialize the bytes from the still-in-memory EPUB and
        // upload/persist them (R2) into a real image URL, and (3) surface `image` in
        // the TS cookbook schema + import path. Cubby has no image-display wiring for
        // cookbook imports today, so this is deferred.
        let chunk = EpubChunk {
            title_hint: c.title_hint,
            text: String::new(),
            doc_path: c.doc_path,
            links: chunk_links,
            images: Vec::new(),
        };
        per_chunk.push((chunk, recipes));
    }
    let recipes = assemble_recipes_internal(per_chunk, links, &source);
    to_js(&recipes, "assembled recipes")
}
