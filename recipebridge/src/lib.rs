use std::{collections::HashSet, str::FromStr};

use ingredient::{
    from_str as parse_ingredient_str,
    rich_text::RichParser,
    unit::{
        convert_measure_with_graph, find_connected_components, is_valid, make_graph, print_graph,
        Measure, MeasureKind,
    },
    unit_mapping::{parse_unit_mapping as parse_unit_mapping_internal, ParsedUnitMapping},
    util::truncate_3_decimals,
};
use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;

// WASM initialization - called automatically when module loads
#[wasm_bindgen(start)]
pub fn init() {
    console_error_panic_hook::set_once();
    let mut config = wasm_tracing::WasmLayerConfig::new();
    config.set_max_level(tracing::Level::INFO);
    let _ = wasm_tracing::set_as_global_default_with_config(config);
}

// Type definitions
/// A pair of measures that can be used for unit conversion
type UnitMappingPairs = Vec<(Measure, Measure)>;

// WebAssembly type definitions
#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(typescript_type = "WIngredient")]
    pub type WIngredient;
    #[wasm_bindgen(typescript_type = "WAmount")]
    pub type WAmount;
    #[wasm_bindgen(typescript_type = "WUnitMapping")]
    pub type WUnitMapping;
    #[wasm_bindgen(typescript_type = "WCompactRecipe")]
    pub type WCompactRecipe;
    #[wasm_bindgen(typescript_type = "RichItem[]")]
    pub type RichItems;
    #[wasm_bindgen(typescript_type = "AmountKind")]
    pub type WAmountKind;
    #[wasm_bindgen(typescript_type = "NutrientConversionResult")]
    pub type NutrientConversionResult;
}

// JS <-> Rust serde boundary
fn from_js<T: for<'de> Deserialize<'de>>(v: impl Into<JsValue>, ctx: &str) -> Result<T, String> {
    serde_wasm_bindgen::from_value(v.into()).map_err(|e| format!("Failed to parse {ctx}: {e}"))
}

fn to_js<T: Serialize>(v: &T, ctx: &str) -> Result<JsValue, String> {
    serde_wasm_bindgen::to_value(v).map_err(|e| format!("Failed to serialize {ctx}: {e}"))
}

// Vec<WUnitMapping> -> Vec<(Measure, Measure)> for conversion graph
fn parse_mappings(mappings: Vec<WUnitMapping>) -> Result<UnitMappingPairs, String> {
    mappings
        .iter()
        .map(|m| from_js::<ParsedUnitMapping>(m, "unit mapping"))
        .collect::<Result<Vec<_>, _>>()
        .map(|v| v.into_iter().map(|m| (m.a, m.b)).collect())
}

// Public API
#[wasm_bindgen]
pub fn format_amount_value(input: &WAmount) -> Result<f64, String> {
    let v = from_js::<Measure>(input, "amount")?.value();
    Ok(truncate_3_decimals(v))
}

#[wasm_bindgen]
pub fn parse_ingredient(input: &str) -> Result<WIngredient, String> {
    to_js(&parse_ingredient_str(input), "ingredient").map(Into::into)
}

#[wasm_bindgen]
pub fn format_amount(amount: &WAmount) -> Result<String, String> {
    Ok(from_js::<Measure>(amount, "amount")?.to_string())
}

#[wasm_bindgen]
pub fn graph_unit_mappings(mappings: Vec<WUnitMapping>) -> Result<String, String> {
    parse_mappings(mappings).map(|p| print_graph(make_graph(&p)))
}

/// Detect disconnected components (islands) in unit mapping graph
/// Returns a list of component groups, where each group is a list of unit strings
#[wasm_bindgen]
pub fn detect_unit_mapping_islands(mappings: Vec<WUnitMapping>) -> Result<JsValue, String> {
    let pairs = parse_mappings(mappings)?;
    let graph = make_graph(&pairs);

    // Find connected components
    let components = find_connected_components(&graph);

    // Convert to JsValue (Vec<Vec<String>>)
    to_js(&components, "connected components")
}

#[wasm_bindgen]
pub fn conv_amount_to_kind(
    mappings: Vec<WUnitMapping>,
    target_kind_w: WAmountKind,
    amount_w: WAmount,
) -> Result<WAmount, String> {
    let pairs = parse_mappings(mappings)?;
    let measure: Measure = from_js(&amount_w, "amount")?;
    let kind_str: String = from_js(target_kind_w, "amount kind")?;
    let kind =
        MeasureKind::from_str(&kind_str).map_err(|_| format!("Invalid amount kind: {kind_str}"))?;

    measure
        .convert_measure_via_mappings(kind.clone(), &pairs)
        .ok_or_else(|| format!("Failed to convert '{measure}' to '{kind}'"))
        .and_then(|m| to_js(&m, "amount").map(Into::into))
}

/// Convert an amount to multiple nutrient targets in a single call
/// Returns a map of target unit -> converted amount (or null if conversion failed)
#[wasm_bindgen]
pub fn conv_amount_to_nutrients(
    mappings: Vec<WUnitMapping>,
    nutrient_targets: Vec<String>, // ["g protein", "mg sodium", "kcal kcal"]
    amount_w: WAmount,
) -> Result<NutrientConversionResult, String> {
    let pairs = parse_mappings(mappings)?;
    let measure: Measure = from_js(&amount_w, "amount")?;
    let graph = make_graph(&pairs);

    // Build JS object manually since serde_wasm_bindgen has issues with HashMap<String, Option<_>>
    let result = js_sys::Object::new();
    for target in nutrient_targets {
        let kind = MeasureKind::Nutrient(target.clone());
        let converted = convert_measure_with_graph(&measure, kind, &graph);

        let js_value = match converted {
            Some(m) => to_js(&m, "amount")?,
            None => JsValue::NULL,
        };

        js_sys::Reflect::set(&result, &JsValue::from_str(&target), &js_value)
            .map_err(|_| "Failed to set property on result object")?;
    }

    Ok(JsValue::from(result).into())
}

/// Convert an amount to a specific unit target (e.g., "g protein")
#[wasm_bindgen]
pub fn conv_amount_to_unit(
    mappings: Vec<WUnitMapping>,
    target_unit: String,
    amount_w: WAmount,
) -> Result<WAmount, String> {
    let pairs = parse_mappings(mappings)?;
    let measure: Measure = from_js(&amount_w, "amount")?;
    let kind = MeasureKind::Nutrient(target_unit.clone());

    measure
        .convert_measure_via_mappings(kind, &pairs)
        .ok_or_else(|| format!("Failed to convert to '{target_unit}'"))
        .and_then(|m| to_js(&m, "amount").map(Into::into))
}

#[wasm_bindgen]
pub fn parse_scraped_recipe(body: &str, url: &str) -> Result<WCompactRecipe, String> {
    recipe_scraper::scrape(body, url)
        .map_err(|e| format!("Failed to scrape: {e}"))
        .and_then(|r| to_js(&r, "recipe").map(Into::into))
}

#[wasm_bindgen]
pub fn parse_rich_text(text: String, ingredient_names: Vec<String>) -> Result<RichItems, String> {
    RichParser::new(ingredient_names)
        .parse(&text)
        .map_err(|e| e.to_string())
        .and_then(|r| to_js(&r, "rich text").map(Into::into))
}

#[wasm_bindgen]
pub fn is_valid_unit(unit: &str, extra_units: Vec<String>) -> bool {
    is_valid(&HashSet::from_iter(extra_units), unit)
}

#[wasm_bindgen]
pub fn amount_kind(amount: &WAmount) -> Result<WAmountKind, String> {
    from_js::<Measure>(amount, "amount")?
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
    to_js(&parse_unit_mapping_internal(&input)?, "parsed unit mapping").map(Into::into)
}

// TypeScript type definitions
#[wasm_bindgen(typescript_custom_section)]
const ITEXT_STYLE: &str = r#"
interface WIngredient {
    amounts: WAmount[];
    modifier?: string;
    name: string;
}

interface WAmount {
    unit: string;
    value: number;
    upper_value?: number;
}

interface WUnitMapping {
    a: WAmount;
    b: WAmount;
    /** Optional source (e.g., "costco" from "4 lb = $5 @ costco") */
    source?: string | null;
}

interface WRecipeYield {
    value: number;
    unit: string;
}

interface WRecipeSection {
    /** Component label (e.g., "For the sauce"); absent for the main/only section */
    name?: string;
    ingredients: string[];
    instructions: string[];
}

interface WCompactRecipe {
    /** Recipe components; most recipes have a single unnamed section */
    sections: WRecipeSection[];
    name?: string;
    url?: string;
    image?: string;
    /** Parsed yield (e.g., { value: 12, unit: "pancakes" }) */
    recipe_yield?: WRecipeYield;
    /** Servings as integer (extracted from yield if unit is "serving(s)") */
    servings?: number;
}

type AmountKind = "weight" | "volume" | "money" | "calories" | "time" | "temperature" | "length" | "other" | `nutrient:${string}`;

/** Result from conv_amount_to_nutrients - maps target unit to converted amount or null */
type NutrientConversionResult = Record<string, WAmount | null>;

type RichItem =
    | { kind: "Text"; value: string }
    | { kind: "Ing"; value: string }
    | { kind: "Measure"; value: WAmount[] };
"#;
