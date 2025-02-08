use ingredient::{
    self,
    rich_text::RichParser,
    unit::{make_graph, print_graph, Measure, MeasureKind},
    IngredientParser,
};
use serde::{Deserialize, Serialize};
use tracing::info;
use wasm_bindgen::prelude::*;

extern crate wee_alloc;

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
#[wasm_bindgen]
pub fn graph_unit_mappings(mappings: Vec<WUnitMapping>) -> Result<String, String> {
    setup();
    let mut mapping_pairs: Vec<(Measure, Measure)> = Vec::new();
    for m in mappings {
        let mapping_rs: Result<UnitMapping, _> = serde_wasm_bindgen::from_value(m.into());
        let mapping = match mapping_rs {
            Ok(mapping) => mapping,
            Err(e) => {
                return Err(format!("failed to parse unit mapping: {e}"));
            }
        };

        mapping_pairs.push((
            raw_amount_to_measure(mapping.a),
            raw_amount_to_measure(mapping.b),
        ));
    }
    let g = make_graph(mapping_pairs.clone());
    let converted_measure = Measure::from_string("100 grams".to_string())
        .convert_measure_via_mappings(MeasureKind::Money, mapping_pairs);
    info!("converted measure: {:?}", converted_measure);

    info!("Graph: {:?}", g);

    Ok(print_graph(g))
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
