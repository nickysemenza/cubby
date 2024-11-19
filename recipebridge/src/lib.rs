use ingredient::{self};
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub fn greet(name: &str) -> String {
    format!("Hello, {}!", name)
}

#[wasm_bindgen]
pub fn fibonacci(n: u32) -> u32 {
    match n {
        0 => 0,
        1 => 1,
        _ => fibonacci(n - 1) + fibonacci(n - 2),
    }
}
#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(typescript_type = "WIngredient")]
    pub type WIngredient;
}

#[wasm_bindgen]
pub fn parse_ingredient(input: &str) -> WIngredient {
    let i = dbg!(ingredient::from_str(input));
    let js_value = serde_wasm_bindgen::to_value(&i).unwrap();
    js_value.into()
}

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
"#;
