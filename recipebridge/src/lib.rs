//! recipebridge: cubby's wasm boundary over the ingredient-parser crates.
//!
//! This file holds the wasm init and the shared boundary primitives (`WAmount`,
//! `WUnitMapping`); the exports live in focused modules:
//! - [`parse`] — ingredient lines, rich instruction text, scraped recipes, yields
//! - [`conversion`] — unit-kind conversion, explained paths, graph debugging
//! - [`food_mappings`] — USDA food/product → unit-mapping synthesis
//! - [`costing`] — the recipe costing engine (consumption model, two-pass totals)
//! - [`epub`] — EPUB cookbook extraction (client-side pipeline)
//!
//! Boundary types: `#[derive(Tsify)]` generates the `.d.ts` from the Rust
//! structs (no hand-written `typescript_custom_section` except `AmountKind`),
//! and the `From<upstream>` impls are the compile-time drift check against
//! ingredient-parser.

use ingredient::unit::Measure;
use serde::{Deserialize, Serialize};
use tsify_next::Tsify;
use wasm_bindgen::prelude::*;

#[macro_use]
mod macros;

mod conversion;
mod costing;
mod epub;
mod food_mappings;
mod parse;

pub use conversion::*;
pub use costing::*;
pub use epub::*;
pub use food_mappings::*;
pub use parse::*;

// WASM initialization - called automatically when module loads
#[wasm_bindgen(start)]
pub fn init() {
    console_error_panic_hook::set_once();
    let mut config = wasm_tracing::WasmLayerConfig::new();
    config.set_max_level(tracing::Level::INFO);
    // workerd (CF Workers) ships a `performance` global without the User
    // Timing API — wasm-tracing's span timings call performance.mark()/
    // measure() unguarded, throwing "performance.mark is not a function" on
    // every traced call. Only report timings where the API actually exists
    // (browsers, Node), so devtools profiles keep their marks in dev.
    config.set_report_logs_in_timings(performance_supports_user_timing());
    let _ = wasm_tracing::set_as_global_default_with_config(config);
}

/// True when the host's `performance` global implements the User Timing API
/// (browsers, Node) rather than workerd's bare now()/timeOrigin stub.
fn performance_supports_user_timing() -> bool {
    js_sys::Reflect::get(&js_sys::global(), &JsValue::from_str("performance"))
        .ok()
        .filter(|p| !p.is_undefined() && !p.is_null())
        .and_then(|p| js_sys::Reflect::get(&p, &JsValue::from_str("mark")).ok())
        .is_some_and(|m| m.is_function())
}

// A pair of measures that can be used for unit conversion
pub(crate) type UnitMappingPairs = Vec<(Measure, Measure)>;

/// A measurement value + unit (mirrors `Measure`).
#[derive(Tsify, Serialize, Deserialize, Clone)]
#[tsify(into_wasm_abi, from_wasm_abi)]
pub struct WAmount {
    pub unit: String,
    pub value: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub upper_value: Option<f64>,
}

impl WAmount {
    pub(crate) fn to_measure(&self) -> Measure {
        match self.upper_value {
            Some(upper) => Measure::with_range(&self.unit, self.value, upper),
            None => Measure::new(&self.unit, self.value),
        }
    }
}

impl From<&Measure> for WAmount {
    fn from(m: &Measure) -> Self {
        Self {
            // `unit().to_str()` (canonical/singular, matching serde) — NOT
            // `unit_as_string()`, which pluralizes for display. `to_str` now
            // returns `Cow`, so own it for the `String` field.
            unit: m.unit().to_str().into_owned(),
            value: m.value(),
            upper_value: m.upper_value(),
        }
    }
}

impl From<Measure> for WAmount {
    fn from(m: Measure) -> Self {
        Self::from(&m)
    }
}

/// A unit-conversion pair, with optional provenance — the single boundary shape
/// for the TS `UnitMapping`. Stored DB rows and synthesized food/price edges
/// carry `sourceMetadata`; `parse_unit_mapping` output and the conversion
/// inputs don't need it (serde ignores it on the way in, skips it when absent).
#[derive(Tsify, Serialize, Deserialize, Clone)]
#[tsify(into_wasm_abi, from_wasm_abi)]
pub struct WUnitMapping {
    pub a: WAmount,
    pub b: WAmount,
    // `string | null`, not `string`: callers pass DB rows with a nullable
    // `source` column (serde maps a JSON `null` to `None`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[tsify(optional, type = "string | null")]
    pub source: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        rename = "sourceMetadata"
    )]
    #[tsify(optional)]
    pub source_metadata: Option<WSourceMetadata>,
}

impl WUnitMapping {
    pub(crate) fn to_pair(&self) -> (Measure, Measure) {
        (self.a.to_measure(), self.b.to_measure())
    }
}

/// `WUnitMapping[]` as a single wasm arg/return (wasm-bindgen can't take a bare
/// `Vec<TsifyStruct>` parameter); `transparent` → `type WUnitMappings = WUnitMapping[]`.
#[derive(Tsify, Serialize, Deserialize)]
#[tsify(into_wasm_abi, from_wasm_abi)]
#[serde(transparent)]
pub struct WUnitMappings(pub Vec<WUnitMapping>);

impl WUnitMappings {
    pub(crate) fn to_pairs(&self) -> UnitMappingPairs {
        self.0.iter().map(WUnitMapping::to_pair).collect()
    }
}

// serde boundary helpers shared by the export modules.
pub(crate) fn from_js<T: for<'de> Deserialize<'de>>(
    v: impl Into<JsValue>,
    ctx: &str,
) -> Result<T, String> {
    serde_wasm_bindgen::from_value(v.into()).map_err(|e| format!("Failed to parse {ctx}: {e}"))
}

pub(crate) fn to_js<T: Serialize>(v: &T, ctx: &str) -> Result<JsValue, String> {
    serde_wasm_bindgen::to_value(v).map_err(|e| format!("Failed to serialize {ctx}: {e}"))
}
