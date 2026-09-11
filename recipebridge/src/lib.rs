//! recipebridge: cubby's wasm boundary over the ingredient-parser crates.
//!
//! This file holds the wasm init and the shared boundary primitives (`WAmount`,
//! `WUnitMapping`); the exports live in focused modules:
//! - [`parse`] — ingredient lines, rich instruction text, scraped recipes, yields
//! - [`conversion`] — unit-kind conversion, explained paths, graph debugging
//! - [`food_mappings`] — USDA food/product → unit-mapping synthesis
//! - [`costing`] — the recipe costing engine (consumption model, two-pass totals)
//! - [`needs`] — sub-recipe expansion into flat, scaled ingredient needs
//! - [`epub`] — EPUB cookbook extraction (client-side pipeline)
//!
//! Boundary types: `#[derive(Tsify)]` generates the `.d.ts` from the Rust
//! structs (no hand-written `typescript_custom_section` except `AmountKind`),
//! and the `From<upstream>` impls are the compile-time drift check against
//! ingredient-parser.

// Production code is held to the `[lints.clippy]` gate in Cargo.toml (no
// unwrap/expect/panic — a panic here is a hard browser crash). Tests legitimately
// use them; allow only under `cfg(test)`, which covers every inline `mod tests`.
#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used, clippy::panic))]

use ingredient::unit::Measure;
use serde::{Deserialize, Serialize};
use tsify_next::Tsify;
use wasm_bindgen::prelude::*;

#[macro_use]
mod macros;

mod availability;
mod conversion;
mod costing;
mod epub;
mod estimates;
mod food_mappings;
mod needs;
mod parse;
mod reconcile;

pub use availability::*;
pub use conversion::*;
pub use costing::*;
pub use epub::*;
pub use estimates::*;
pub use food_mappings::*;
pub use needs::*;
pub use parse::*;

// WASM initialization - called automatically when module loads
#[wasm_bindgen(start)]
pub fn init() {
    console_error_panic_hook::set_once();
    let mut config = wasm_tracing::WasmLayerConfig::new();
    // The costing engine's per-conversion hot path
    // (ingredient::unit::convert_measure_with_graph_explained) is
    // `#[tracing::instrument]` at INFO, so at an INFO subscriber level EVERY
    // conversion builds a span that Debug-formats the whole MeasureGraph. One
    // `cost_recipes` call does thousands of conversions → thousands of such spans
    // through this GLOBAL subscriber. In a browser that's a short-lived page and
    // harmless; on the REUSED workerd isolate the subscriber's span registry
    // accumulates across calls and per-call CPU climbs without bound — a recompute
    // drain measured 47ms → 53s on identical 10-recipe chunks until it tripped the
    // 45s CPU limit. (The cost was invisible because workerd freezes
    // performance.now() during the pure-CPU WASM call, so it mis-attributed to the
    // next DB write.) Cap workerd at WARN so those INFO spans are never created
    // (tracing short-circuits at the level check); the multi-priced `warn!`
    // tripwire still fires. Browsers / Node keep INFO for devtools spans.
    config.set_max_level(if is_workerd() {
        tracing::Level::WARN
    } else {
        tracing::Level::INFO
    });
    // workerd (CF Workers) ships a `performance` global without the User
    // Timing API — wasm-tracing's span timings call performance.mark()/
    // measure() unguarded, throwing "performance.mark is not a function" on
    // every traced call. Only report timings where the API actually exists
    // (browsers, Node), so devtools profiles keep their marks in dev.
    config.set_report_logs_in_timings(performance_supports_user_timing());
    // Cloudflare's workerd console.log does NOT interpret the `%c` CSS format
    // directives that wasm-tracing's colored output emits, so styled logs leak
    // raw `%c … ; color: orange` noise into `wrangler tail`. Browsers render the
    // colors; Node's console silently ignores `%c`. Only workerd mangles them —
    // emit plain, un-styled logs there.
    if is_workerd() {
        config.set_console_config(wasm_tracing::ConsoleConfig::ReportWithoutConsoleColor);
    }
    let _ = wasm_tracing::set_as_global_default_with_config(config);
}

/// True when the host's `performance` global implements the User Timing API
/// (browsers, Node) rather than workerd's bare now()/timeOrigin stub. Any
/// Reflect failure (missing global, a throwing getter) folds to `false` — the
/// safe "don't emit timings" path — so detection never panics init.
fn performance_supports_user_timing() -> bool {
    js_sys::Reflect::get(&js_sys::global(), &JsValue::from_str("performance"))
        .ok()
        .filter(|p| !p.is_undefined() && !p.is_null())
        .and_then(|p| js_sys::Reflect::get(&p, &JsValue::from_str("mark")).ok())
        .is_some_and(|m| m.is_function())
}

/// True when running inside Cloudflare's workerd runtime, which sets
/// `navigator.userAgent` to the sentinel "Cloudflare-Workers".
///
/// **Fails closed: an inconclusive detection returns `true` (assume workerd).**
/// This single boolean is all that holds back an INFO-level tracing subscriber
/// on the costing hot path, and on the reused workerd isolate that subscriber's
/// span registry grows without bound until it trips `cpu_ms` (see [`init`] for
/// the 47ms → 53s measurement). The two failure modes are not symmetric:
/// mis-detecting a browser as workerd costs only devtools spans and `%c` log
/// colors; mis-detecting workerd as a browser takes production down. So only a
/// *successfully read string* that isn't the sentinel returns `false` — a
/// missing `navigator`, a throwing getter, or a non-string `userAgent` all fold
/// to `true` rather than to the dangerous path. Reflect errors are still
/// swallowed rather than unwrapped, so detection never panics init.
fn is_workerd() -> bool {
    let user_agent = js_sys::Reflect::get(&js_sys::global(), &JsValue::from_str("navigator"))
        .ok()
        .filter(|n| !n.is_undefined() && !n.is_null())
        .and_then(|n| js_sys::Reflect::get(&n, &JsValue::from_str("userAgent")).ok())
        .and_then(|ua| ua.as_string());
    workerd_from_user_agent(user_agent.as_deref())
}

/// The decision half of [`is_workerd`], split out because the probe above needs
/// a JS global and so can only run on wasm — this is the part worth testing.
///
/// `None` means detection was inconclusive (no `navigator`, a throwing getter,
/// a non-string `userAgent`) and answers **true**. The failure modes are not
/// symmetric: guessing "browser" on workerd re-arms the INFO-level subscriber
/// on the hot path, whose per-call cost grows until it trips `cpu_ms`, while
/// guessing "workerd" in a browser only costs devtools spans and `%c` colors.
fn workerd_from_user_agent(user_agent: Option<&str>) -> bool {
    match user_agent {
        Some(ua) => ua == "Cloudflare-Workers",
        None => true,
    }
}

#[cfg(test)]
mod workerd_detection_tests {
    use super::workerd_from_user_agent;

    #[test]
    fn detects_workerd_by_exact_user_agent() {
        assert!(workerd_from_user_agent(Some("Cloudflare-Workers")));
    }

    #[test]
    fn treats_a_real_browser_as_not_workerd() {
        assert!(!workerd_from_user_agent(Some(
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"
        )));
    }

    /// The regression this guards: inconclusive detection must fail CLOSED.
    /// Returning false here is what previously let an INFO subscriber onto the
    /// wasm hot path in production.
    #[test]
    fn assumes_workerd_when_detection_is_inconclusive() {
        assert!(workerd_from_user_agent(None));
    }
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

    /// Multiply by `factor`, leaving non-scalable kinds alone. A recipe scaled
    /// 2× needs twice the flour but not an 18-inch pan, a 700°F oven, or a
    /// 60-minute rest — `Measure::scale` owns that rule, and routing through it
    /// is what keeps the decision in one place instead of at each call site.
    ///
    /// The caller's unit spelling is preserved rather than canonicalized.
    /// `Measure::scale` deliberately does not normalize, so scaling changes the
    /// numbers and nothing else; without this, the `Measure` round-trip would
    /// re-spell `"inch"` as `"` and `"tablespoons"` as `"tbsp"`, making a scaled
    /// recipe read differently from the same recipe at 1×.
    pub(crate) fn scale(&self, factor: f64) -> Self {
        Self {
            unit: self.unit.clone(),
            ..Self::from(self.to_measure().scale(factor))
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
/// carry `sourceMetadata`; plain conversion inputs don't need it (serde ignores
/// it on the way in, skips it when absent).
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

#[cfg(test)]
mod amount_scale_tests {
    use super::WAmount;

    fn amount(unit: &str, value: f64) -> WAmount {
        WAmount {
            unit: unit.into(),
            value,
            upper_value: None,
        }
    }

    #[test]
    fn scales_both_ends_of_a_range() {
        let scaled = WAmount {
            upper_value: Some(20.0),
            ..amount("g", 10.0)
        }
        .scale(2.5);
        assert_eq!(scaled.value, 25.0);
        assert_eq!(scaled.upper_value, Some(50.0));
    }

    /// The bug this crate shipped before `Measure::scale` existed: doubling a
    /// recipe resized the pan, reset the oven, and doubled the resting time.
    #[test]
    fn leaves_non_scalable_kinds_alone() {
        for unit in ["inch", "minute", "°F"] {
            let scaled = amount(unit, 9.0).scale(2.0);
            assert_eq!(scaled.value, 9.0, "{unit} must not scale");
            assert_eq!(scaled.unit, unit);
        }
    }

    #[test]
    fn scales_weight_and_volume() {
        assert_eq!(amount("g", 100.0).scale(2.5).value, 250.0);
        assert_eq!(amount("cup", 2.0).scale(0.5).value, 1.0);
    }

    /// Scaling changes numbers only. Canonicalizing here would make a 2× recipe
    /// read "tbsp" where the 1× recipe (returned untouched) reads "tablespoons".
    #[test]
    fn preserves_the_authored_unit_spelling() {
        for unit in ["tablespoons", "inch", "Cups"] {
            assert_eq!(amount(unit, 2.0).scale(2.0).unit, unit);
        }
    }

    /// Exact because `Measure` multiplies rationals, not floats — `1/3 × 3` is
    /// `1`, not `0.9999999999999998`.
    #[test]
    fn thirds_scale_exactly() {
        assert_eq!(amount("cup", 1.0 / 3.0).scale(3.0).value, 1.0);
    }
}
