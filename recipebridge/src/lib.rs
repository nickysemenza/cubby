use std::{collections::HashSet, str::FromStr};

use ingredient::{
    self,
    rich_text::RichParser,
    unit::{is_valid, make_graph, print_graph, Measure, MeasureKind},
    IngredientParser,
};
use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;

extern crate wee_alloc;

// Constants
const FLOAT_PRECISION: f64 = 1000.0;

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
}

// Global allocator setup
#[global_allocator]
static ALLOC: wee_alloc::WeeAlloc = wee_alloc::WeeAlloc::INIT;

// Helper functions
/// Initializes the WebAssembly environment
fn setup() {
    console_error_panic_hook::set_once();
    let _ = wasm_tracing::try_set_as_global_default();
}

/// Converts a vector of UnitMapping to UnitMappingPairs
fn mappings_to_pairs(mappings: Vec<UnitMapping>) -> UnitMappingPairs {
    mappings
        .into_iter()
        .map(|m| (m.a.to_measure(), m.b.to_measure()))
        .collect()
}

/// Converts WebAssembly unit mappings to Rust unit mappings
fn mappings_from_w(mappings: Vec<WUnitMapping>) -> Result<UnitMappingPairs, String> {
    setup();
    let parsed_mappings: Result<Vec<UnitMapping>, String> = mappings
        .iter()
        .map(|m| {
            serde_wasm_bindgen::from_value(m.into())
                .map_err(|e| format!("Failed to parse unit mapping: {}", e))
        })
        .collect();

    Ok(mappings_to_pairs(parsed_mappings?))
}

// Public API functions
/// Formats a measure value with specified precision
#[wasm_bindgen]
pub fn format_measure_value(input: &WMeasure) -> Result<f64, String> {
    setup();
    let measure: RawAmount = serde_wasm_bindgen::from_value(input.into())
        .map_err(|e| format!("Failed to parse measure: {}", e))?;
    Ok(f64::trunc(measure.to_measure().values().0 * FLOAT_PRECISION) / FLOAT_PRECISION)
}

/// Parses an ingredient string into a WIngredient
#[wasm_bindgen]
pub fn parse_ingredient(input: &str) -> Result<WIngredient, String> {
    setup();
    let i = ingredient::from_str(input);
    serde_wasm_bindgen::to_value(&i)
        .map_err(|e| format!("Failed to serialize ingredient: {}", e))
        .map(|v| v.into())
}

/// Formats a raw amount into a string representation
#[wasm_bindgen]
pub fn format_amount(amount: &WMeasure) -> Result<String, String> {
    setup();
    serde_wasm_bindgen::from_value(amount.into())
        .map(|a: RawAmount| format!("{}", a.to_measure()))
        .map_err(|e| format!("Failed to format amount: {}", e))
}

/// Creates a graph representation of unit mappings
#[wasm_bindgen]
pub fn graph_unit_mappings(mappings: Vec<WUnitMapping>) -> Result<String, String> {
    setup();
    mappings_from_w(mappings).map(|pairs| print_graph(make_graph(pairs)))
}

/// Converts a measure to a different kind using provided mappings
#[wasm_bindgen]
pub fn conv_measure_to_kind(
    mappings: Vec<WUnitMapping>,
    input_target_measure_kind: String,
    input_measure_w: WMeasure,
) -> Result<WMeasure, String> {
    setup();
    let mapping_pairs = mappings_from_w(mappings)?;
    let input_measure: RawAmount = serde_wasm_bindgen::from_value(input_measure_w.into())
        .map_err(|e| format!("Failed to parse input amount: {}", e))?;
    let target_measure_kind = MeasureKind::from_str(&input_target_measure_kind)
        .map_err(|_| format!("Invalid measure kind: {}", input_target_measure_kind))?;

    let input_measure = input_measure.to_measure();
    input_measure
        .convert_measure_via_mappings(target_measure_kind.clone(), mapping_pairs)
        .map(|m| serde_wasm_bindgen::to_value(&m).unwrap().into())
        .ok_or_else(|| {
            format!(
                "conv_measure_to_kind: failed to convert '{}' to target measure '{}'",
                input_measure, target_measure_kind
            )
        })
}

/// Parses a scraped recipe from HTML content
#[wasm_bindgen]
pub fn parse_scraped_recipe(body: &str, url: &str) -> Result<WCompactRecipe, String> {
    setup();
    recipe_scraper::scrape(body, url)
        .map_err(|e| format!("Failed to scrape recipe: {}", e))
        .and_then(|r| {
            serde_wasm_bindgen::to_value(&r)
                .map(|v| v.into())
                .map_err(|e| format!("Failed to serialize recipe: {}", e))
        })
}

/// Parses rich text with ingredient names
#[wasm_bindgen]
pub fn parse_rich_text(r: String, ingredient_names: Vec<String>) -> Result<RichItems, JsValue> {
    setup();
    let rtp = RichParser {
        ingredient_names,
        ip: IngredientParser::new(true),
    };
    rtp.parse(r.as_str())
        .map(|r| serde_wasm_bindgen::to_value(&r).unwrap().into())
        .map_err(|e| JsValue::from_str(&e))
}

#[wasm_bindgen]
pub fn is_valid_unit(unit: &str, extra_units: Vec<String>) -> bool {
    setup();
    is_valid(HashSet::from_iter(extra_units), unit)
}

// TypeScript type definitions
#[wasm_bindgen(typescript_custom_section)]
const ITEXT_STYLE: &'static str = r#"
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

type RichItem =
    | { kind: "Text"; value: string }
    | { kind: "Ing"; value: string }
    | { kind: "Measure"; value: WMeasure[] };
"#;
