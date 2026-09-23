//! EPUB cookbook extraction.
//!
//! Everything lives upstream in `cookbook::wasm`: `open_book(bytes, label)`
//! returns a `Book` handle with `outline()`, `estimate(options)`,
//! `extract(options, send, on_progress)` (a `Promise<Extraction>` driven
//! through the `send` callback, cubby's authenticated gateway forwarder),
//! `cancel()`, `read_image(path)`, `image_mime(path)`, `cover()`, and
//! `sha256()`; plus `usage_from_response(model, body)` for AI-usage
//! accounting, `default_ladder()`, and `model_catalog()`. Re-exported here so
//! wasm-bindgen emits them from this cdylib and tsify writes their types into
//! the generated `.d.ts`.
pub use cookbook::wasm::*;

use wasm_bindgen::prelude::*;

/// Price app chat models absent from the cookbook ladder catalog using the
/// same Rust model table pinned by Cargo.lock.
#[wasm_bindgen]
pub fn rust_model_rates(id: &str) -> Result<JsValue, JsError> {
    let rates = llm_models_spider::MODEL_INFO
        .iter()
        .find(|entry| entry.name == id)
        .filter(|entry| entry.cost_input_x1000 > 0 && entry.cost_output_x1000 > 0)
        .map(|entry| cookbook::models::Rates {
            input: entry.cost_input_x1000 as f64 / 1000.0,
            output: entry.cost_output_x1000 as f64 / 1000.0,
        });
    serde_wasm_bindgen::to_value(&rates).map_err(|error| JsError::new(&error.to_string()))
}
