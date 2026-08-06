//! Sub-recipe expansion for ingredient needs.
//!
//! A sub-recipe reference is not an ingredient — it's a *transform* that
//! produces more needs for other ingredients. So this module does only the
//! recursion: (planned lines + recipe closure) → flat, scaled per-ingredient
//! needs, plus a record of every sub-recipe that could NOT be expanded.
//! Reconciling those needs against inventory stays entirely in
//! [`crate::availability`], which never learns what a recipe is.
//!
//! The recursion mirrors the costing engine's `sub_recipe_pairs` discipline —
//! path-scoped cycle guard, taint-aware memo, and a hard guard on a
//! non-positive yield — because those were each paid for by a real bug there.

use std::cell::RefCell;
use std::collections::{HashMap, HashSet};

use ingredient::unit::{Measure, MeasureKind, make_graph};
use serde::{Deserialize, Serialize};
use tsify_next::Tsify;
use wasm_bindgen::prelude::*;

use crate::WAmount;
use crate::costing::WRowKind;
use crate::reconcile::convert_with_fallback;

/// Synthetic unit standing for "one batch of the sub-recipe". Must be already
/// lowercase and already singular so `Measure::normalize`'s `Unit::Other`
/// handling round-trips it unchanged (same trick as `conversion`'s
/// `cubbygraphnode{i}` probe nodes).
const BATCH_UNIT: &str = "cubbybatch";

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

/// One flattened section-ingredient row. Sections carry no meaning here, so the
/// caller flattens them away.
#[derive(Tsify, Serialize, Deserialize)]
pub struct WNeedsRow {
    pub kind: WRowKind,
    /// Ingredient id or sub-recipe id, per `kind`.
    pub target_id: String,
    pub name: String,
    /// Written amounts in source order. Empty for an amount-less line
    /// ("salt, to taste").
    #[serde(default)]
    pub amounts: Vec<WAmount>,
}

/// One recipe in the closure — a planned root, or a transitively reached sub.
#[derive(Tsify, Serialize, Deserialize)]
pub struct WNeedsRecipe {
    pub id: String,
    pub name: String,
    /// Required for this recipe to be usable *as* a sub-recipe: without it
    /// there's no way to know how much of a batch the parent is asking for.
    #[serde(default)]
    #[tsify(optional, type = "WAmount | null")]
    pub recipe_yield: Option<WAmount>,
    pub rows: Vec<WNeedsRow>,
}

/// One planned line: make `recipe_id` at `scale`. `line_index` is opaque and
/// echoed onto every need the line produces, so the caller can attribute a
/// need back to its meal without this module knowing what a meal is.
#[derive(Tsify, Serialize, Deserialize)]
pub struct WNeedsLine {
    pub recipe_id: String,
    pub scale: f64,
    pub line_index: u32,
}

#[derive(Tsify, Serialize, Deserialize)]
#[tsify(from_wasm_abi)]
pub struct WNeedsInput {
    pub lines: Vec<WNeedsLine>,
    /// Every root in `lines`, plus every transitively reachable sub-recipe.
    pub recipes: Vec<WNeedsRecipe>,
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

/// One hop of the sub-recipe chain a need was reached through, outermost first.
#[derive(Tsify, Serialize, Deserialize, Clone)]
pub struct WNeedsVia {
    pub recipe_id: String,
    pub name: String,
}

/// One ingredient need, already scaled by `line.scale × Π(yield fractions)`.
/// The unit is the authored one — picking a gram-first basis is the
/// availability evaluator's job, not this module's.
#[derive(Tsify, Serialize, Deserialize)]
pub struct WExpandedNeed {
    pub ingredient_id: String,
    pub name: String,
    /// `None` when the line names an ingredient but no amount ("to taste").
    /// Reported rather than dropped, so the caller can still surface the row.
    #[serde(default)]
    #[tsify(optional, type = "WAmount | null")]
    pub amount: Option<WAmount>,
    pub line_index: u32,
    /// Empty for a row written directly on the planned recipe.
    pub via: Vec<WNeedsVia>,
}

/// Why a sub-recipe's needs are absent. Values match the zod
/// `subRecipeBlockReason` literals.
#[derive(Tsify, Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
pub enum WNeedsBlockReason {
    /// The reference re-enters a recipe already on the current path.
    Cycle,
    /// The sub-recipe declares no yield, or a non-positive / non-finite one.
    MissingYield,
    /// The sub-recipe id isn't in the provided closure (deleted mid-flight).
    UnknownRecipe,
    /// No conversion path from the written amount to the yield's unit — "200 g"
    /// of a batch that yields "8 servings".
    Unscalable,
    /// The parent line references the sub-recipe with no amount at all.
    NoAmount,
}

/// A sub-recipe reference whose ingredients are NOT in `needs`. This is the
/// disclosure record: an omission the caller is obliged to surface, never a
/// silent zero.
#[derive(Tsify, Serialize, Deserialize)]
pub struct WBlockedSubRecipe {
    pub recipe_id: String,
    pub name: String,
    pub line_index: u32,
    pub reason: WNeedsBlockReason,
    /// The parent's written amount, for display ("2 cup of Pizza dough").
    #[serde(default)]
    #[tsify(optional, type = "WAmount | null")]
    pub amount: Option<WAmount>,
    pub via: Vec<WNeedsVia>,
}

#[derive(Tsify, Serialize, Deserialize)]
#[tsify(into_wasm_abi)]
pub struct WNeedsResult {
    pub needs: Vec<WExpandedNeed>,
    pub blocked: Vec<WBlockedSubRecipe>,
}

/// One sub-recipe reference: the sub's declared yield, and the parent's written
/// amounts for the row referencing it.
#[derive(Tsify, Serialize, Deserialize)]
#[tsify(from_wasm_abi)]
pub struct WYieldFractionInput {
    #[serde(default)]
    #[tsify(optional, type = "WAmount | null")]
    pub recipe_yield: Option<WAmount>,
    #[serde(default)]
    pub amounts: Vec<WAmount>,
}

/// Exactly one of `fraction` / `reason` is present. `fraction` is batches of the
/// sub-recipe; `reason` is the same verdict the shopping list discloses, so the
/// two surfaces can never disagree about what is knowable.
#[derive(Tsify, Serialize, Deserialize)]
#[tsify(into_wasm_abi)]
pub struct WYieldFraction {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[tsify(optional)]
    pub fraction: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[tsify(optional)]
    pub reason: Option<WNeedsBlockReason>,
}

// ---------------------------------------------------------------------------
// Yield math
// ---------------------------------------------------------------------------

/// Whether a declared yield can denominate anything at all. See the saturation
/// note in [`yield_fraction`] for why a zero is a hazard and not just a no-op.
fn usable_yield(recipe_yield: &WAmount) -> bool {
    recipe_yield.value.is_finite() && recipe_yield.value > 0.0
}

/// How many batches of `recipe_yield` the written `amounts` represent.
///
/// Putting the yield on one side of a synthetic graph edge and "1 batch" on the
/// other makes the edge the per-batch rate, so the unit engine does all the
/// work: `1.5 kg` normalizes to `1500 g` and answers a parent written in `g`,
/// `8 cup` answers one written in `quart`, and `8 servings` answers
/// `2 servings` through `Unit::Other` singularization. A parent whose unit
/// can't reach the yield's — including one written in a unit the table doesn't
/// know at all — returns `None`. A disclosed omission beats a guessed
/// conversion: the whole point here is to stop the shopping list being
/// confidently wrong.
///
/// This is the single implementation of yield scaling. The tree UI reaches it
/// through the [`recipe_yield_fraction`] export rather than approximating it.
pub(crate) fn yield_fraction(recipe_yield: &WAmount, amounts: &[WAmount]) -> Option<f64> {
    // A zero/negative/non-finite yield is not merely useless, it's dangerous:
    // `make_graph` divides by the mapping's value, and the rational conversion
    // SATURATES rather than going infinite, so `finite()` can't reject the
    // result. A "1 batch = 0 g" edge silently yields a ~9.2e16 factor that
    // multiplies every descendant need while still reading as real data. The
    // costing engine gates its weight edge on `> 0.0` for exactly this reason.
    if !(recipe_yield.value.is_finite() && recipe_yield.value > 0.0) {
        return None;
    }
    let pairs = [(recipe_yield.to_measure(), Measure::new(BATCH_UNIT, 1.0))];
    let graph = make_graph(&pairs);
    let measures: Vec<Measure> = amounts.iter().map(WAmount::to_measure).collect();
    let fraction = convert_with_fallback(
        &measures,
        &graph,
        MeasureKind::Other(BATCH_UNIT.to_string()),
    )?
    .value();
    // Belt and braces against a saturated rational or a non-positive amount.
    (fraction.is_finite() && fraction > 0.0).then_some(fraction)
}

/// The batch fraction a parent's written amounts represent, or the reason the
/// engine declines to guess.
///
/// The single ladder behind both [`expand_recipe_needs`] — which turns an `Err`
/// into a disclosed omission — and the [`recipe_yield_fraction`] export, which
/// hands the verdict to the tree UI so it can decide its own fallback. Cycle and
/// UnknownRecipe are deliberately NOT here: those are properties of the
/// recursion, not of this pair of amounts.
///
/// Order matters and mirrors `expand_batch`: a reference with no amount at all
/// is `NoAmount` even when the sub-recipe also lacks a yield, because that's the
/// nearer of the two fixes.
pub fn yield_verdict(
    recipe_yield: Option<&WAmount>,
    amounts: &[WAmount],
) -> Result<f64, WNeedsBlockReason> {
    if amounts.is_empty() {
        return Err(WNeedsBlockReason::NoAmount);
    }
    // A declared-but-unusable yield (0, negative, non-finite) is reported as
    // missing rather than unscalable: the fix is "give this recipe a yield", not
    // "these units don't relate", and that's what the disclosure will say.
    let Some(recipe_yield) = recipe_yield.filter(|y| usable_yield(y)) else {
        return Err(WNeedsBlockReason::MissingYield);
    };
    yield_fraction(recipe_yield, amounts).ok_or(WNeedsBlockReason::Unscalable)
}

fn scale_amount(amount: &WAmount, factor: f64) -> WAmount {
    WAmount {
        unit: amount.unit.clone(),
        value: amount.value * factor,
        upper_value: amount.upper_value.map(|upper| upper * factor),
    }
}

// ---------------------------------------------------------------------------
// Expansion
// ---------------------------------------------------------------------------

#[derive(Clone)]
struct PartialNeed {
    ingredient_id: String,
    name: String,
    amount: Option<WAmount>,
    via: Vec<WNeedsVia>,
}

#[derive(Clone)]
struct PartialBlock {
    recipe_id: String,
    name: String,
    reason: WNeedsBlockReason,
    amount: Option<WAmount>,
    via: Vec<WNeedsVia>,
}

/// One batch (factor 1.0) of a recipe, fully expanded. `via` chains are
/// relative to this recipe; a use site prepends its own hop.
#[derive(Clone, Default)]
struct BatchExpansion {
    needs: Vec<PartialNeed>,
    blocked: Vec<PartialBlock>,
}

fn prepend(hop: &WNeedsVia, rest: Vec<WNeedsVia>) -> Vec<WNeedsVia> {
    let mut via = Vec::with_capacity(rest.len() + 1);
    via.push(hop.clone());
    via.extend(rest);
    via
}

struct Expander<'a> {
    recipes: HashMap<&'a str, &'a WNeedsRecipe>,
    /// One-batch expansions by recipe id. A cycle-tainted subtree is NEVER
    /// cached: its value depends on where in the recursion it was reached, not
    /// on the recipe id alone.
    batches: RefCell<HashMap<String, BatchExpansion>>,
}

impl<'a> Expander<'a> {
    fn new(input: &'a WNeedsInput) -> Self {
        Self {
            recipes: input.recipes.iter().map(|r| (r.id.as_str(), r)).collect(),
            batches: RefCell::new(HashMap::new()),
        }
    }

    fn recipe(&self, id: &str) -> Option<&'a WNeedsRecipe> {
        self.recipes.get(id).copied()
    }

    /// Memoized one-batch expansion, entering `recipe` on the visited path.
    fn batch_for(
        &self,
        recipe: &WNeedsRecipe,
        visited: &HashSet<String>,
        taint: &mut bool,
    ) -> BatchExpansion {
        let cached = self.batches.borrow().get(&recipe.id).cloned();
        if let Some(hit) = cached {
            return hit;
        }
        let mut path = visited.clone();
        path.insert(recipe.id.clone());
        let mut sub_taint = false;
        let expansion = self.expand_batch(recipe, &path, &mut sub_taint);
        if sub_taint {
            *taint = true;
        } else {
            self.batches
                .borrow_mut()
                .insert(recipe.id.clone(), expansion.clone());
        }
        expansion
    }

    fn expand_batch(
        &self,
        recipe: &WNeedsRecipe,
        visited: &HashSet<String>,
        taint: &mut bool,
    ) -> BatchExpansion {
        let mut out = BatchExpansion::default();

        for row in &recipe.rows {
            match row.kind {
                WRowKind::Ingredient => out.needs.push(PartialNeed {
                    ingredient_id: row.target_id.clone(),
                    name: row.name.clone(),
                    // Deliberately the FIRST written amount, not the
                    // mass-preferred canonical one: that's the basis the
                    // shopping list already reports, and changing it would move
                    // every existing number under cover of this change.
                    amount: row.amounts.first().cloned(),
                    via: Vec::new(),
                }),
                WRowKind::Recipe => {
                    let blocked = |reason| PartialBlock {
                        recipe_id: row.target_id.clone(),
                        name: row.name.clone(),
                        reason,
                        amount: row.amounts.first().cloned(),
                        via: Vec::new(),
                    };

                    if visited.contains(&row.target_id) {
                        // The result now depends on the visited set rather than
                        // the recipe id, so nothing on this path may be cached.
                        *taint = true;
                        out.blocked.push(blocked(WNeedsBlockReason::Cycle));
                        continue;
                    }
                    let Some(sub) = self.recipe(&row.target_id) else {
                        out.blocked.push(blocked(WNeedsBlockReason::UnknownRecipe));
                        continue;
                    };
                    let fraction = match yield_verdict(sub.recipe_yield.as_ref(), &row.amounts) {
                        Ok(fraction) => fraction,
                        Err(reason) => {
                            out.blocked.push(blocked(reason));
                            continue;
                        }
                    };

                    let expansion = self.batch_for(sub, visited, taint);
                    let hop = WNeedsVia {
                        recipe_id: sub.id.clone(),
                        name: sub.name.clone(),
                    };
                    for need in expansion.needs {
                        out.needs.push(PartialNeed {
                            ingredient_id: need.ingredient_id,
                            name: need.name,
                            amount: need.amount.map(|a| scale_amount(&a, fraction)),
                            via: prepend(&hop, need.via),
                        });
                    }
                    // A partially-expandable sub still contributes what it
                    // could: the dough's flour lands even when the dough's own
                    // poolish is cyclic, and the block names exactly what didn't.
                    for block in expansion.blocked {
                        out.blocked.push(PartialBlock {
                            via: prepend(&hop, block.via),
                            ..block
                        });
                    }
                }
            }
        }

        out
    }
}

/// Expand every planned line into flat, scaled ingredient needs.
///
/// Errors only on malformed input (a line naming a recipe absent from the
/// closure — a caller contract violation). Everything that can go wrong with
/// the *data* is in-band in `blocked`, because a shopping list that 500s is
/// worse than one that says which sub-recipe it couldn't break down.
pub fn expand_recipe_needs_impl(input: &WNeedsInput) -> Result<WNeedsResult, String> {
    let expander = Expander::new(input);
    let mut needs = Vec::new();
    let mut blocked = Vec::new();

    for line in &input.lines {
        let recipe = expander
            .recipe(&line.recipe_id)
            .ok_or_else(|| format!("unknown root recipe id: {}", line.recipe_id))?;
        // A non-finite or non-positive scale would poison every need on the
        // line; zod validates it upstream, but the wasm boundary is public.
        if !(line.scale.is_finite() && line.scale > 0.0) {
            continue;
        }

        let mut taint = false;
        let expansion = expander.batch_for(recipe, &HashSet::new(), &mut taint);

        for need in expansion.needs {
            needs.push(WExpandedNeed {
                ingredient_id: need.ingredient_id,
                name: need.name,
                amount: need.amount.map(|a| scale_amount(&a, line.scale)),
                line_index: line.line_index,
                via: need.via,
            });
        }
        for block in expansion.blocked {
            blocked.push(WBlockedSubRecipe {
                recipe_id: block.recipe_id,
                name: block.name,
                line_index: line.line_index,
                reason: block.reason,
                amount: block.amount,
                via: block.via,
            });
        }
    }

    Ok(WNeedsResult { needs, blocked })
}

#[wasm_bindgen]
pub fn expand_recipe_needs(input: WNeedsInput) -> Result<WNeedsResult, String> {
    expand_recipe_needs_impl(&input)
}

/// How many batches of a sub-recipe a parent's written amounts represent.
///
/// The tree UI's counterpart to [`expand_recipe_needs`]: same math, same
/// decline reasons, one row at a time. The caller decides what a decline means
/// — the shopping list omits the sub-recipe and discloses it, while the prep
/// sheet falls back to the costing engine's own batch weight and flags the row.
/// That fallback can't live here: its denominator is a costing total, and this
/// module deliberately knows nothing about costing.
#[wasm_bindgen]
pub fn recipe_yield_fraction(input: WYieldFractionInput) -> WYieldFraction {
    match yield_verdict(input.recipe_yield.as_ref(), &input.amounts) {
        Ok(fraction) => WYieldFraction {
            fraction: Some(fraction),
            reason: None,
        },
        Err(reason) => WYieldFraction {
            fraction: None,
            reason: Some(reason),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn amount(unit: &str, value: f64) -> WAmount {
        WAmount {
            unit: unit.to_string(),
            value,
            upper_value: None,
        }
    }

    #[test]
    fn resolves_a_fraction_against_a_matching_unit() {
        let f = yield_fraction(&amount("cup", 4.0), &[amount("cup", 2.0)]);
        assert_eq!(f, Some(0.5));
    }

    #[test]
    fn resolves_a_mass_yield_across_units() {
        // 1.5 kg normalizes to 1500 g, so a parent written in g reaches it.
        let f = yield_fraction(&amount("kg", 1.5), &[amount("g", 300.0)]);
        assert!(f.is_some_and(|v| (v - 0.2).abs() < 1e-6), "got {f:?}");
    }

    #[test]
    fn resolves_a_volume_yield_across_units() {
        // 1 quart = 4 cup, so half of an 8-cup batch.
        let f = yield_fraction(&amount("cup", 8.0), &[amount("quart", 1.0)]);
        assert!(f.is_some_and(|v| (v - 0.5).abs() < 1e-6), "got {f:?}");
    }

    #[test]
    fn treats_an_unrecognized_unit_as_unscalable() {
        // "pint" isn't in the unit table, so it parses as Unit::Other and has
        // no edge to cup. Blocked-and-disclosed is the right degradation —
        // guessing a conversion here is how a shopping list becomes confidently
        // wrong.
        assert_eq!(
            yield_fraction(&amount("cup", 4.0), &[amount("pint", 1.0)]),
            None
        );
    }

    #[test]
    fn resolves_a_count_yield_through_singularization() {
        let f = yield_fraction(&amount("servings", 8.0), &[amount("serving", 2.0)]);
        assert!(f.is_some_and(|v| (v - 0.25).abs() < 1e-6), "got {f:?}");
    }

    #[test]
    fn keeps_a_fractional_batch() {
        let f = yield_fraction(&amount("cup", 3.0), &[amount("cup", 1.0)]);
        assert!(f.is_some_and(|v| (v - 1.0 / 3.0).abs() < 1e-4), "got {f:?}");
    }

    #[test]
    fn refuses_a_non_convertible_parent_amount() {
        // Nothing relates grams to servings without a density for the batch.
        assert_eq!(
            yield_fraction(&amount("servings", 8.0), &[amount("g", 200.0)]),
            None
        );
    }

    #[test]
    fn refuses_a_zero_yield_rather_than_saturating() {
        // The regression that matters: a 1/0 edge saturates instead of going
        // infinite, so without the guard this returns a finite ~9.2e16.
        assert_eq!(
            yield_fraction(&amount("cup", 0.0), &[amount("cup", 2.0)]),
            None
        );
    }

    #[test]
    fn refuses_a_non_finite_yield() {
        assert_eq!(
            yield_fraction(&amount("cup", f64::NAN), &[amount("cup", 2.0)]),
            None
        );
        assert_eq!(
            yield_fraction(&amount("cup", f64::INFINITY), &[amount("cup", 2.0)]),
            None
        );
    }

    // `yield_verdict` is the ladder `expand_batch` and the wasm export share.
    // Its reason ordering is load-bearing: it decides which fix a disclosure
    // asks the user for.

    #[test]
    fn verdict_reports_a_missing_amount_before_a_missing_yield() {
        // Both are wrong, but "this line has no amount" is the nearer fix.
        assert_eq!(yield_verdict(None, &[]), Err(WNeedsBlockReason::NoAmount));
        assert_eq!(
            yield_verdict(Some(&amount("cup", 4.0)), &[]),
            Err(WNeedsBlockReason::NoAmount)
        );
    }

    #[test]
    fn verdict_treats_an_unusable_yield_as_missing() {
        for bad in [0.0, -4.0, f64::NAN, f64::INFINITY] {
            assert_eq!(
                yield_verdict(Some(&amount("cup", bad)), &[amount("cup", 2.0)]),
                Err(WNeedsBlockReason::MissingYield),
                "yield value {bad}",
            );
        }
        assert_eq!(
            yield_verdict(None, &[amount("cup", 2.0)]),
            Err(WNeedsBlockReason::MissingYield)
        );
    }

    #[test]
    fn verdict_reports_unrelatable_units_as_unscalable() {
        assert_eq!(
            yield_verdict(Some(&amount("servings", 8.0)), &[amount("g", 200.0)]),
            Err(WNeedsBlockReason::Unscalable)
        );
    }

    #[test]
    fn verdict_agrees_with_yield_fraction_on_the_happy_path() {
        // Guards the shim: the export must not develop its own opinion.
        let recipe_yield = amount("cup", 4.0);
        let amounts = [amount("cup", 2.0)];
        assert_eq!(
            yield_verdict(Some(&recipe_yield), &amounts).ok(),
            yield_fraction(&recipe_yield, &amounts),
        );
    }

    #[test]
    fn export_returns_exactly_one_of_fraction_or_reason() {
        let ok = recipe_yield_fraction(WYieldFractionInput {
            recipe_yield: Some(amount("cup", 4.0)),
            amounts: vec![amount("cup", 1.0)],
        });
        assert!(ok.fraction.is_some_and(|f| (f - 0.25).abs() < 1e-9));
        assert!(ok.reason.is_none());

        let declined = recipe_yield_fraction(WYieldFractionInput {
            recipe_yield: None,
            amounts: vec![amount("cup", 1.0)],
        });
        assert!(declined.fraction.is_none());
        assert_eq!(declined.reason, Some(WNeedsBlockReason::MissingYield));
    }

    #[test]
    fn scales_both_ends_of_a_range() {
        let scaled = scale_amount(
            &WAmount {
                unit: "g".into(),
                value: 10.0,
                upper_value: Some(20.0),
            },
            2.5,
        );
        assert_eq!(scaled.value, 25.0);
        assert_eq!(scaled.upper_value, Some(50.0));
    }
}
