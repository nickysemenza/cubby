//! UniFFI boundary exposing `recipebridge` to Swift on iOS and macOS. Same Rust
//! source as the wasm builds the web app uses, compiled without recipebridge's
//! `wasm` feature; this crate only translates its types into UniFFI records at
//! the boundary. Modules mirror the recipebridge modules they wrap:
//! - [`ingredient`] — ingredient-line parsing and the shared `Amount` record
//! - [`isbn`] — ISBN normalization and scan-code GTIN-14 identity
//! - [`display`] — currency, number, amount and estimate label text
//! - [`scaling`] — scale-factor anchors, per-amount scaling, scaled counts
//!
//! Some records are deliberately reduced projections (`ParsedIngredient`,
//! `EstimateFigure`): native gets only the fields a screen reads, and adding a
//! field later is additive. There is no `uniffi::Error`: the ingredient
//! exports are infallible (the parser falls back to a name-only ingredient) and
//! the ISBN exports return `Option` for "not a valid code"; a dead error enum
//! would trip `-D warnings`.

uniffi::setup_scaffolding!();

mod display;
mod ingredient;
mod isbn;
mod scaling;

pub use display::*;
pub use ingredient::*;
pub use isbn::*;
pub use scaling::*;
