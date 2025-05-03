use std::str::FromStr;

use ingredient::{
    self,
    rich_text::RichParser,
    unit::{make_graph, print_graph, Measure, MeasureKind},
    IngredientParser,
};
use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;

extern crate wee_alloc;

/// A pair of measures that can be used for unit conversion
type UnitMappingPairs = Vec<(Measure, Measure)>;

/// Represents a raw amount with a unit and value
#[derive(Clone, PartialEq, PartialOrd, Debug, Serialize, Deserialize)]
pub struct RawAmount {
    unit: String,
    value: f64,
    upper_value: Option<f64>,
}

/// Represents a mapping between two raw amounts
#[derive(Clone, PartialEq, PartialOrd, Debug, Serialize, Deserialize)]
pub struct UnitMapping {
    a: RawAmount,
    b: RawAmount,
}

// Use `wee_alloc` as the global allocator.
#[global_allocator]
static ALLOC: wee_alloc::WeeAlloc = wee_alloc::WeeAlloc::INIT;

/// Precision for floating point number formatting
const FLOAT_PRECISION: f64 = 1000.0;

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(typescript_type = "WIngredient")]
    pub type WIngredient;
    #[wasm_bindgen(typescript_type = "WMeasure")]
    pub type WMeasure;
    #[wasm_bindgen(typescript_type = "WRawAmount")]
    pub type WRawAmount;
    #[wasm_bindgen(typescript_type = "WUnitMapping")]
    pub type WUnitMapping;
    #[wasm_bindgen(typescript_type = "WCompactRecipe")]
    pub type WCompactRecipe;
    #[wasm_bindgen(typescript_type = "RichItem[]")]
    pub type RichItems;
}

/// Formats a measure value with specified precision
#[wasm_bindgen]
pub fn format_measure_value(input: &WMeasure) -> Result<f64, String> {
    setup();
    let measure: Measure = serde_wasm_bindgen::from_value(input.into())
        .map_err(|e| format!("Failed to parse measure: {}", e))?;
    Ok(f64::trunc(measure.values().0 * FLOAT_PRECISION) / FLOAT_PRECISION)
}

/// Parses an ingredient string into a WIngredient
#[wasm_bindgen]
pub fn parse_ingredient(input: &str) -> Result<WIngredient, String> {
    setup();
    let i = ingredient::from_str(input);
    let js_value = serde_wasm_bindgen::to_value(&i)
        .map_err(|e| format!("Failed to serialize ingredient: {}", e))?;
    Ok(js_value.into())
}

/// Formats a raw amount into a string representation
#[wasm_bindgen]
pub fn format_amount(amount: &WRawAmount) -> Result<String, String> {
    setup();
    let a1: Result<RawAmount, _> = serde_wasm_bindgen::from_value(amount.into());
    match a1 {
        Ok(a) => Ok(format!("{}", raw_amount_to_measure(a))),
        Err(e) => Err(format!("Failed to format amount: {}", e)),
    }
}

/// Formats a measure into a string representation
#[wasm_bindgen]
pub fn format_measure(amount: &WMeasure) -> Result<String, String> {
    setup();
    let a1: Result<Measure, _> = serde_wasm_bindgen::from_value(amount.into());
    match a1 {
        Ok(a) => Ok(format!("{}", a)),
        Err(e) => Err(format!("Failed to format measure: {}", e)),
    }
}

/// Converts a RawAmount to a Measure
fn raw_amount_to_measure(a: RawAmount) -> Measure {
    Measure::from_parts(a.unit.as_str(), a.value, a.upper_value)
}

/// Converts a vector of UnitMapping to UnitMappingPairs
fn mappings_to_pairs(mappings: Vec<UnitMapping>) -> UnitMappingPairs {
    mappings
        .into_iter()
        .map(|m| (raw_amount_to_measure(m.a), raw_amount_to_measure(m.b)))
        .collect()
}

/// Converts WebAssembly unit mappings to Rust unit mappings
fn mappings_from_w(mappings: Vec<WUnitMapping>) -> Result<UnitMappingPairs, String> {
    setup();
    let parsed_mappings: Result<Vec<UnitMapping>, String> = mappings
        .iter()
        .map(|m| {
            let mapping_rs: Result<UnitMapping, _> = serde_wasm_bindgen::from_value(m.into());
            mapping_rs.map_err(|e| format!("Failed to parse unit mapping: {}", e))
        })
        .collect();

    Ok(mappings_to_pairs(parsed_mappings?))
}

/// Creates a graph representation of unit mappings
#[wasm_bindgen]
pub fn graph_unit_mappings(mappings: Vec<WUnitMapping>) -> Result<String, String> {
    setup();
    let mapping_pairs = mappings_from_w(mappings)?;
    Ok(print_graph(make_graph(mapping_pairs)))
}

/// Initializes the WebAssembly environment
fn setup() {
    console_error_panic_hook::set_once();
    let _ = wasm_tracing::try_set_as_global_default();
}

#[wasm_bindgen]
pub fn convert_to_measure_via_mappings(
    mappings: Vec<WUnitMapping>,
    input_measure_kind: String,
    input_measure_w: WMeasure,
) -> Result<WMeasure, String> {
    setup();
    let mapping_pairs =
        mappings_from_w(mappings).map_err(|e| format!("failed to parse mappings: {e}"))?;

    let measure: Result<Measure, _> = serde_wasm_bindgen::from_value(input_measure_w.into());
    let input_measure = measure.map_err(|e| format!("failed to parse input amount: {e}"))?;

    let target_measure_kind = MeasureKind::from_str(&input_measure_kind)
        .map_err(|_| format!("invalid measure kind: {}", input_measure_kind))?;
    let converted_measure =
        input_measure.convert_measure_via_mappings(target_measure_kind.clone(), mapping_pairs);
    match converted_measure {
        Some(m) => {
            let js_value = serde_wasm_bindgen::to_value(&m).unwrap();
            Ok(js_value.into())
        }
        None => Err(format!(
            "convert_to_measure_via_mappings: failed to convert '{}' to target measure '{}'",
            input_measure, target_measure_kind,
        )),
    }
}

#[wasm_bindgen]
pub fn parse_scraped_recipe(body: &str, url: &str) -> Result<WCompactRecipe, String> {
    setup();
    let r =
        recipe_scraper::scrape(body, url).map_err(|e| format!("Failed to scrape recipe: {}", e))?;
    let js_value = serde_wasm_bindgen::to_value(&r).unwrap();
    Ok(js_value.into())
}
#[wasm_bindgen]
pub fn parse_rich_text(r: String, ingredient_names: Vec<String>) -> Result<RichItems, JsValue> {
    setup();
    let rtp = RichParser {
        ingredient_names,
        ip: IngredientParser::new(true),
    };
    match rtp.parse(r.as_str()) {
        Ok(r) => Ok(serde_wasm_bindgen::to_value(&r).unwrap().into()),
        Err(e) => Err(JsValue::from_str(&e)),
    }
}
#[wasm_bindgen(typescript_custom_section)]
const ITEXT_STYLE: &'static str = r#"
interface WIngredient {
    amounts: WMeasure[];
    modifier?: string;
    name: string;
}
type OtherUnitEnum = {"Other": string};
interface WMeasure {
  unit: string | OtherUnitEnum;
  value: number;
  upper_value?: number;
}
interface WUnitMapping {
    a: WRawAmount;
    b: WRawAmount;
}
interface WRawAmount {
    unit: string;
    value: number;
    upper_value?: number;
}
interface WCompactRecipe{
  ingredients: string[];
  instructions: string[];
  name?: string;
  url?: string;
  image?: string;
}
type RichItem =
| { kind: "Text"; value: string }
| { kind: "Ing"; value: string }
| { kind: "Measure"; value: WMeasure[] }
"#;
