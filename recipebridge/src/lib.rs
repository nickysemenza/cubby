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
type UnitMappings = Vec<(Measure, Measure)>;
#[derive(Clone, PartialEq, PartialOrd, Debug, Serialize, Deserialize)]
pub struct RawAmount {
    unit: String,
    value: f64,
    upper_value: Option<f64>,
}
#[derive(Clone, PartialEq, PartialOrd, Debug, Serialize, Deserialize)]
pub struct UnitMapping {
    a: RawAmount,
    b: RawAmount,
}

// Use `wee_alloc` as the global allocator.
#[global_allocator]
static ALLOC: wee_alloc::WeeAlloc = wee_alloc::WeeAlloc::INIT;

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

#[wasm_bindgen]
pub fn format_measure_value(input: &WMeasure) -> f64 {
    let measure: Measure = serde_wasm_bindgen::from_value(input.into()).unwrap();
    // truncate2_decimals
    f64::trunc(measure.values().0 * 1000.0) / 1000.0
}

#[wasm_bindgen]
pub fn parse_ingredient(input: &str) -> WIngredient {
    let i = dbg!(ingredient::from_str(input));
    let js_value = serde_wasm_bindgen::to_value(&i).unwrap();
    js_value.into()
}

#[wasm_bindgen]
pub fn format_amount(amount: &WRawAmount) -> String {
    // utils::set_panic_hook();
    let a1: Result<RawAmount, _> = serde_wasm_bindgen::from_value(amount.into());
    match a1 {
        Ok(a) => {
            let a2 = Measure::from_parts(a.unit.as_str(), a.value, a.upper_value);
            format!("{}", a2)
        }
        Err(e) => {
            format!("{e}")
        }
    }
}
fn raw_amount_to_measure(a: RawAmount) -> Measure {
    Measure::from_parts(a.unit.as_str(), a.value, a.upper_value)
}
fn mappings_to_pairs(mappings: Vec<UnitMapping>) -> UnitMappings {
    let mut mapping_pairs: UnitMappings = Vec::new();
    for m in mappings {
        mapping_pairs.push((raw_amount_to_measure(m.a), raw_amount_to_measure(m.b)));
    }
    mapping_pairs
}
pub fn mappings_from_w(mappings: Vec<WUnitMapping>) -> UnitMappings {
    let parsed_mappings: Result<Vec<UnitMapping>, String> = mappings
        .iter()
        .map(|m| {
            let mapping_rs: Result<UnitMapping, _> = serde_wasm_bindgen::from_value(m.into());
            match mapping_rs {
                Ok(mapping) => Ok(mapping),
                Err(e) => Err(format!("failed to parse unit mapping: {e}")),
            }
        })
        .collect();
    mappings_to_pairs(parsed_mappings.unwrap())
}
#[wasm_bindgen]
pub fn graph_unit_mappings(mappings: Vec<WUnitMapping>) -> Result<String, String> {
    setup();
    Ok(print_graph(make_graph(mappings_from_w(mappings))))
}

#[wasm_bindgen]
pub fn test_convert_to_target(mappings: Vec<WUnitMapping>, mk: String) -> String {
    setup();
    let mapping_pairs = mappings_from_w(mappings);
    let target_measure = Measure::from_string("100 grams".to_string());
    let converted_measure = target_measure
        .convert_measure_via_mappings(MeasureKind::from_str(&mk).unwrap(), mapping_pairs);
    match converted_measure {
        Some(m) => format!("{}={}", target_measure, m),
        None => format!(
            "failed to convert {} to {} target measure",
            target_measure, mk
        ),
    }
}

fn setup() {
    console_error_panic_hook::set_once();
    let _ = wasm_tracing::try_set_as_global_default();
}

#[wasm_bindgen]
pub fn parse_scraped_recipe(body: &str, url: &str) -> WCompactRecipe {
    setup();
    let r = recipe_scraper::scrape(body, url).unwrap();
    let js_value = serde_wasm_bindgen::to_value(&r).unwrap();
    js_value.into()
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
