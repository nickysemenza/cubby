use std::{collections::HashSet, str::FromStr};

use ingredient::{
    from_str as parse_ingredient_str,
    rich_text::RichParser,
    unit::{is_valid, make_graph, print_graph, Measure, MeasureKind},
    IngredientParser,
};
use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;

// Constants
const FLOAT_PRECISION: f64 = 1000.0;

// WASM initialization - called automatically when module loads
#[wasm_bindgen(start)]
pub fn init() {
    console_error_panic_hook::set_once();
    let _ = wasm_tracing::try_set_as_global_default();
}

// Type definitions
/// A pair of measures that can be used for unit conversion
type UnitMappingPairs = Vec<(Measure, Measure)>;

/// RawMeasure is a measure with the unit as a string
#[derive(Clone, PartialEq, PartialOrd, Debug, Serialize, Deserialize)]
pub struct RawAmount {
    unit: String,
    value: f64,
    upper_value: Option<f64>,
}
impl RawAmount {
    pub fn to_measure(&self) -> Measure {
        Measure::from_parts(self.unit.as_str(), self.value, self.upper_value)
    }
}
/// Represents a mapping between two raw amounts
#[derive(Clone, PartialEq, PartialOrd, Debug, Serialize, Deserialize)]
pub struct UnitMapping {
    a: RawAmount,
    b: RawAmount,
}

// WebAssembly type definitions
#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(typescript_type = "WIngredient")]
    pub type WIngredient;
    #[wasm_bindgen(typescript_type = "WMeasure")]
    pub type WMeasure;
    #[wasm_bindgen(typescript_type = "WUnitMapping")]
    pub type WUnitMapping;
    #[wasm_bindgen(typescript_type = "WCompactRecipe")]
    pub type WCompactRecipe;
    #[wasm_bindgen(typescript_type = "RichItem[]")]
    pub type RichItems;
    #[wasm_bindgen(typescript_type = "MeasureKind")]
    pub type WMeasureKind;
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
        .map(|m| from_js::<UnitMapping>(m, "unit mapping"))
        .collect::<Result<Vec<_>, _>>()
        .map(|v| {
            v.into_iter()
                .map(|m| (m.a.to_measure(), m.b.to_measure()))
                .collect()
        })
}

// Public API
#[wasm_bindgen]
pub fn format_measure_value(input: &WMeasure) -> Result<f64, String> {
    let v = from_js::<RawAmount>(input, "measure")?
        .to_measure()
        .values()
        .0;
    Ok(f64::trunc(v * FLOAT_PRECISION) / FLOAT_PRECISION)
}

#[wasm_bindgen]
pub fn parse_ingredient(input: &str) -> Result<WIngredient, String> {
    to_js(&parse_ingredient_str(input), "ingredient").map(Into::into)
}

#[wasm_bindgen]
pub fn format_amount(amount: &WMeasure) -> Result<String, String> {
    Ok(from_js::<RawAmount>(amount, "measure")?
        .to_measure()
        .to_string())
}

#[wasm_bindgen]
pub fn graph_unit_mappings(mappings: Vec<WUnitMapping>) -> Result<String, String> {
    parse_mappings(mappings).map(|p| print_graph(make_graph(p)))
}

#[wasm_bindgen]
pub fn conv_measure_to_kind(
    mappings: Vec<WUnitMapping>,
    target_kind_w: WMeasureKind,
    measure_w: WMeasure,
) -> Result<WMeasure, String> {
    let pairs = parse_mappings(mappings)?;
    let measure = from_js::<RawAmount>(&measure_w, "measure")?.to_measure();
    let kind_str: String = from_js(target_kind_w, "measure kind")?;
    let kind = MeasureKind::from_str(&kind_str)
        .map_err(|_| format!("Invalid measure kind: {kind_str}"))?;

    measure
        .convert_measure_via_mappings(kind.clone(), pairs)
        .ok_or_else(|| format!("Failed to convert '{measure}' to '{kind}'"))
        .and_then(|m| to_js(&m, "measure").map(Into::into))
}

#[wasm_bindgen]
pub fn parse_scraped_recipe(body: &str, url: &str) -> Result<WCompactRecipe, String> {
    recipe_scraper::scrape(body, url)
        .map_err(|e| format!("Failed to scrape: {e}"))
        .and_then(|r| to_js(&r, "recipe").map(Into::into))
}

#[wasm_bindgen]
pub fn parse_rich_text(text: String, ingredient_names: Vec<String>) -> Result<RichItems, String> {
    RichParser {
        ingredient_names,
        ip: IngredientParser::new().with_rich_text(),
    }
    .parse(&text)
    .map_err(|e| e.to_string())
    .and_then(|r| to_js(&r, "rich text").map(Into::into))
}

#[wasm_bindgen]
pub fn is_valid_unit(unit: &str, extra_units: Vec<String>) -> bool {
    is_valid(&HashSet::from_iter(extra_units), unit)
}

#[wasm_bindgen]
pub fn measure_kind(amount: &WMeasure) -> Result<WMeasureKind, String> {
    from_js::<RawAmount>(amount, "measure")?
        .to_measure()
        .kind()
        .map_err(|_| "Unknown unit kind".to_string())
        .and_then(|k| to_js(&k.to_str(), "measure kind").map(Into::into))
}

// TypeScript type definitions
#[wasm_bindgen(typescript_custom_section)]
const ITEXT_STYLE: &str = r#"
interface WIngredient {
    amounts: WMeasure[];
    modifier?: string;
    name: string;
}

interface WMeasure {
    unit: string;
    value: number;
    upper_value?: number;
}

interface WUnitMapping {
    a: WMeasure;
    b: WMeasure;
}

interface WCompactRecipe {
    ingredients: string[];
    instructions: string[];
    name?: string;
    url?: string;
    image?: string;
}

type MeasureKind = "weight" | "volume" | "money" | "calories" | "time" | "temperature" | "length" | "other";

type RichItem =
    | { kind: "Text"; value: string }
    | { kind: "Ing"; value: string }
    | { kind: "Measure"; value: WMeasure[] };
"#;
