//! Recipe costing: consumption model + two-pass totals engine + boundary types.
//!
//! Port of apps/web/src/lib/recipe-costing.ts — the TS module is now a thin
//! wrapper over the `cost_recipes` export in lib.rs. Pure serde + `ingredient`
//! code (no JsValue) so the parity suite runs under native `cargo test`.

mod consumption;
mod engine;
mod types;

pub use consumption::*;
pub use types::*;

use std::collections::HashSet;

use engine::Engine;
use wasm_bindgen::prelude::*;

/// Cost every root recipe in the input: one `WRecipeCosting` per `root_ids`
/// entry, in order. Errors only on malformed input (a root id missing from the
/// closure); per-row conversion failures are in-band `{ok:false}` results.
pub fn cost_recipes_impl(input: &WCostingInput) -> Result<WCostingResult, String> {
    let engine = Engine::new(input);
    let mut recipes = Vec::with_capacity(input.root_ids.len());
    for root_id in &input.root_ids {
        let recipe = engine
            .recipe(root_id)
            .ok_or_else(|| format!("unknown root recipe id: {root_id}"))?;
        recipes.push(engine.cost_recipe(recipe, &HashSet::new(), input.explain));
    }
    Ok(WCostingResult { recipes })
}

/// Cost a batch of recipes in one call: totals + per-row resolved measures +
/// usage estimates + baker percentages + diagnostics (and, with
/// `input.explain`, unit-graph conversion paths). The whole two-pass
/// consumption-model engine runs in Rust — the TS `computeRecipeCosting` is a
/// thin wrapper that assembles the input and reshapes the result.
#[wasm_bindgen]
pub fn cost_recipes(input: WCostingInput) -> Result<WCostingResult, String> {
    cost_recipes_impl(&input)
}
