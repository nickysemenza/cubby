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
