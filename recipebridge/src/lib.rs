use ingredient::{self, unit::Measure};
use wasm_bindgen::prelude::*;

extern crate wee_alloc;

// Use `wee_alloc` as the global allocator.
#[global_allocator]
static ALLOC: wee_alloc::WeeAlloc = wee_alloc::WeeAlloc::INIT;

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
    #[wasm_bindgen(typescript_type = "WMeasure")]
    pub type WMeasure;
    #[wasm_bindgen(typescript_type = "WCompactRecipe")]
    pub type WCompactRecipe;
}

#[wasm_bindgen]
pub fn parse_ingredient(input: &str) -> WIngredient {
    let i = dbg!(ingredient::from_str(input));
    let js_value = serde_wasm_bindgen::to_value(&i).unwrap();
    js_value.into()
}

#[wasm_bindgen]
pub fn format_amount(amount: &WMeasure) -> String {
    // utils::set_panic_hook();
    let a1: Result<Measure, _> = serde_wasm_bindgen::from_value(amount.into());
    match a1 {
        Ok(a) => format!("{a}"),
        Err(e) => {
            // error!("failed to format {:#?}: {:?}", amount, e);
            format!("{e}")
        }
    }
}

fn setup() {
    console_error_panic_hook::set_once();
    let _ = wasm_tracing::try_set_as_global_default();
    // use std::sync::Once;
    // static SET_HOOK: Once = Once::new();
    // SET_HOOK.call_once(|| {
    //     wasm_tracing::set_as_global_default();
    // });
}
#[wasm_bindgen]
pub fn parse_scraped_recipe(body: &str, url: &str) -> WCompactRecipe {
    setup();
    let r = recipe_scraper::scrape(body, url).unwrap();
    let js_value = serde_wasm_bindgen::to_value(&r).unwrap();
    js_value.into()
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
interface WCompactRecipe{
  ingredients: string[];
  instructions: string[];
  name?: string;
  url?: string;
  image?: string;
}
"#;
