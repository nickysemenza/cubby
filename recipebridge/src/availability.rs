//! Availability evaluator: "do I have what this needs, and what am I short?".
//!
//! The shared engine behind "what can I make?", the `find_cookable_recipes`
//! agent tool, and the meal-planning shopping list. Reconciliation runs on the
//! same kernel the costing engine uses (`reconcile::product_mapping_pairs` +
//! `ingredient`'s graph conversion), so the gram-first basis rule has one home
//! instead of a parallel TS copy.
//!
//! A group is one ingredient's needs (one need for recipe availability, many for
//! the aggregated shopping list) against its products' on-hand inventory. The
//! caller (TS) owns the DB loads and shapes the result into the zod output
//! types; this owns the unit math and the status verdict.
//!
//! Hardening that TS couldn't express: the `Basis` coherence enum makes a
//! mixed-unit aggregate ("2 cup" + "300 g") return `Incoherent` → `unconvertible`
//! instead of silently summing into a meaningless total, and non-finite values
//! are dropped before they can poison a sum.

use ingredient::unit::{
    Measure, MeasureGraph, MeasureKind, convert_measure_with_graph, make_graph,
};
use serde::{Deserialize, Serialize};
use tsify_next::Tsify;
use wasm_bindgen::prelude::*;

use crate::WAmount;
use crate::food_mappings::WProductInput;
use crate::reconcile::{finite, product_mapping_pairs};

/// Tiny tolerance so float rounding doesn't flip an exact match to "short".
/// The only copy: the shopping list re-verdicts through
/// [`availability_status_for`] rather than carrying its own.
const COVERAGE_EPSILON: f64 = 1e-6;

// ---------------------------------------------------------------------------
// Boundary types
// ---------------------------------------------------------------------------

/// One need: an authored amount plus the index of the line that needs it, echoed
/// back in `sources` so the caller can attribute each contribution to its meal.
#[derive(Tsify, Serialize, Deserialize)]
#[tsify(from_wasm_abi)]
pub struct WAvailabilityNeed {
    pub amount: WAmount,
    pub line_index: u32,
}

/// One product backing an ingredient: its synthesis input (mappings derived
/// Rust-side) plus the on-hand inventory entries for that product.
#[derive(Tsify, Serialize, Deserialize)]
#[tsify(from_wasm_abi)]
pub struct WAvailabilityProduct {
    pub product: WProductInput,
    pub on_hand: Vec<WAmount>,
}

/// One ingredient's needs against its inventory. `key` is opaque — echoed back so
/// the caller can zip results onto its own rows (a row index for recipe
/// availability, an ingredient id for the aggregated shopping list).
#[derive(Tsify, Serialize, Deserialize)]
#[tsify(from_wasm_abi)]
pub struct WAvailabilityGroup {
    pub key: String,
    pub needs: Vec<WAvailabilityNeed>,
    pub products: Vec<WAvailabilityProduct>,
}

#[derive(Tsify, Serialize, Deserialize)]
#[tsify(from_wasm_abi)]
pub struct WAvailabilityInput {
    pub groups: Vec<WAvailabilityGroup>,
}

/// Status verdict. Mirrors the zod `ingredientAvailabilityStatus` minus
/// `subrecipe` (sub-recipes never reach the evaluator — the caller handles them).
#[derive(Tsify, Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
// `from_wasm_abi` too: `availability_status_for` takes a prior verdict back in.
#[tsify(into_wasm_abi, from_wasm_abi)]
#[serde(rename_all = "lowercase")]
pub enum WAvailabilityStatus {
    /// Enough on hand.
    Ok,
    /// Some on hand, but not enough.
    Short,
    /// None on hand.
    Missing,
    /// On hand, but its unit can't be reconciled with the need.
    Unconvertible,
}

/// One need's contribution, in the basis unit, tagged with its line index.
#[derive(Tsify, Serialize, Deserialize)]
#[tsify(into_wasm_abi)]
pub struct WAvailabilitySource {
    pub line_index: u32,
    pub need_value: f64,
}

#[derive(Tsify, Serialize, Deserialize)]
#[tsify(into_wasm_abi)]
pub struct WAvailabilityGroupResult {
    pub key: String,
    pub basis_unit: String,
    pub need_value: f64,
    #[serde(default)]
    #[tsify(type = "number | null")]
    pub have_value: Option<f64>,
    pub status: WAvailabilityStatus,
    /// `need - have`, floored at zero. `None` when on-hand isn't known — see
    /// `shortfall_for`.
    #[serde(default)]
    #[tsify(type = "number | null")]
    pub shortfall: Option<f64>,
    pub sources: Vec<WAvailabilitySource>,
}

#[derive(Tsify, Serialize, Deserialize)]
#[tsify(into_wasm_abi)]
pub struct WAvailabilityResult {
    pub groups: Vec<WAvailabilityGroupResult>,
}

// ---------------------------------------------------------------------------
// Core
// ---------------------------------------------------------------------------

/// The unit a group's need/have are compared in. Prefer a grams basis (every
/// need converts to weight); else the needs' shared authored unit. `Incoherent`
/// — needs span multiple authored units with no common weight basis — is the
/// type-level guard against summing apples and oranges: an exhaustive match must
/// handle it, so it can't silently become a bogus total the way the old TS sum
/// did.
enum Basis {
    Weight(String),
    Unit(String),
    Incoherent,
}

/// Does a known on-hand total cover a need? The one home of the epsilon.
fn compare_coverage(need_value: f64, have_total: f64) -> WAvailabilityStatus {
    use WAvailabilityStatus::*;
    if have_total + COVERAGE_EPSILON >= need_value {
        Ok
    } else if have_total > 0.0 {
        Short
    } else {
        Missing
    }
}

fn resolve_status(
    need_value: f64,
    have_total: f64,
    any_entries: bool,
    any_convertible: bool,
) -> WAvailabilityStatus {
    if !any_entries {
        WAvailabilityStatus::Missing
    } else if !any_convertible {
        WAvailabilityStatus::Unconvertible
    } else {
        compare_coverage(need_value, have_total)
    }
}

/// How much of a need the on-hand total doesn't cover, or `None` when on-hand
/// isn't known.
///
/// `None` is the honest answer for an unconvertible row: treating unknown stock
/// as zero asserts a shortfall equal to the entire need, and sorts that
/// invented number to the top of a buy-list.
fn shortfall_for(need_value: f64, have_value: Option<f64>) -> Option<f64> {
    have_value.map(|have| (need_value - have).max(0.0))
}

/// Re-verdict an item against a reduced need — the shopping list excluding some
/// planned meals client-side, where re-sending the whole inventory to
/// [`evaluate_availability`] would be absurd.
///
/// A `None` on-hand means either "no inventory" or "units don't reconcile", and
/// only the original evaluation knows which, so `prior` stands. Everything else
/// goes through the same comparison the evaluator uses.
#[wasm_bindgen]
pub fn availability_status_for(
    need_value: f64,
    have_value: Option<f64>,
    prior: WAvailabilityStatus,
) -> WAvailabilityStatus {
    match have_value {
        Some(have) => compare_coverage(need_value, have),
        None => prior,
    }
}

fn evaluate_group(group: &WAvailabilityGroup) -> WAvailabilityGroupResult {
    // No needs → nothing to satisfy. Return an inert `Ok` (a zero requirement is
    // met), not `Missing` — `Missing` would render as "you're short on this" for
    // a group that needs nothing. `basis_unit` is empty: there's no unit to
    // compare in.
    if group.needs.is_empty() {
        return WAvailabilityGroupResult {
            key: group.key.clone(),
            basis_unit: String::new(),
            need_value: 0.0,
            have_value: None,
            status: WAvailabilityStatus::Ok,
            shortfall: None,
            sources: Vec::new(),
        };
    }

    // Per-product graphs (for on-hand, converted via the matching product's
    // mappings) plus the merged graph (for needs, which may bridge across
    // products) — the same split the TS service used.
    let product_pairs: Vec<Vec<(Measure, Measure)>> = group
        .products
        .iter()
        .map(|p| product_mapping_pairs(&p.product))
        .collect();
    let product_graphs: Vec<MeasureGraph> = product_pairs.iter().map(|p| make_graph(p)).collect();
    // Needs may bridge across products, so they resolve on the union of all edges.
    // With exactly one product that union *is* its graph — reuse it instead of
    // rebuilding a second graph and re-cloning every pair (the common case: most
    // ingredients have a single product).
    let mut merged_graph: Option<MeasureGraph> = None;
    let all_graph: &MeasureGraph = match product_graphs.as_slice() {
        // Single product: its graph already is the union — reuse it (the common
        // case), no rebuild or pair re-clone.
        [single] => single,
        // 0 or ≥2 products: resolve needs on the union of all edges. With zero
        // products the union is empty, so nothing converts.
        _ => {
            let all_pairs: Vec<(Measure, Measure)> =
                product_pairs.iter().flatten().cloned().collect();
            merged_graph.insert(make_graph(&all_pairs))
        }
    };

    // Convert each need to weight. Gram basis only when EVERY need converts, so
    // contributions are summable in one unit (the gram-first rule).
    let weights: Vec<Option<Measure>> = group
        .needs
        .iter()
        .map(|n| convert_measure_with_graph(&n.amount.to_measure(), MeasureKind::Weight, all_graph))
        .collect();
    let all_weight = !weights.is_empty() && weights.iter().all(Option::is_some);

    let basis = if all_weight {
        // all_weight ⇒ every entry is Some, so the first weight's unit is the basis.
        match weights.iter().flatten().next() {
            Some(m) => Basis::Weight(m.unit().to_str().into_owned()),
            None => Basis::Incoherent, // unreachable (non-empty, all Some); defensive
        }
    } else {
        match group.needs.first() {
            None => Basis::Unit(String::new()),
            Some(first) => {
                if group
                    .needs
                    .iter()
                    .all(|n| n.amount.unit == first.amount.unit)
                {
                    Basis::Unit(first.amount.unit.clone())
                } else {
                    Basis::Incoherent
                }
            }
        }
    };

    // Per-need contribution in the basis unit (grams when all_weight, else the
    // authored value — the same gram-first fallback as the TS service). Zipped
    // with `weights` so there's no parallel-index access: under a weight basis
    // every `weight` is Some, and the authored-value fallback (never hit) keeps
    // it panic-free.
    let sources: Vec<WAvailabilitySource> = group
        .needs
        .iter()
        .zip(&weights)
        .map(|(n, weight)| {
            let need_value = match &basis {
                Basis::Weight(_) => weight.as_ref().map_or(n.amount.value, Measure::value),
                _ => n.amount.value,
            };
            WAvailabilitySource {
                line_index: n.line_index,
                need_value,
            }
        })
        .collect();
    let need_total: f64 = sources.iter().filter_map(|s| finite(s.need_value)).sum();

    // On-hand total, counted ONCE per group (across all its products) — summing
    // per-line would multiply inventory by the number of needs.
    let any_entries = group.products.iter().any(|p| !p.on_hand.is_empty());
    let mut have_total = 0.0_f64;
    let mut any_convertible = false;
    for (i, p) in group.products.iter().enumerate() {
        for on_hand in &p.on_hand {
            let value = match &basis {
                Basis::Weight(_) => convert_measure_with_graph(
                    &on_hand.to_measure(),
                    MeasureKind::Weight,
                    &product_graphs[i],
                )
                .map(|g| g.value()),
                Basis::Unit(unit) => (on_hand.unit == *unit).then_some(on_hand.value),
                Basis::Incoherent => None,
            };
            if let Some(v) = value.and_then(finite) {
                have_total += v;
                any_convertible = true;
            }
        }
    }

    let mut sources = sources;
    let (status, basis_unit, need_value, have_value) = match &basis {
        // Mixed units with no weight basis: surface as unconvertible rather than
        // a confident-but-wrong total. `need_total` here is the meaningless
        // mixed-unit sum (e.g. 2 + 300), so zero it out — both the total and the
        // per-source values — so nothing downstream can render it as a quantity.
        Basis::Incoherent => {
            for s in &mut sources {
                s.need_value = 0.0;
            }
            (
                WAvailabilityStatus::Unconvertible,
                group
                    .needs
                    .first()
                    .map(|n| n.amount.unit.clone())
                    .unwrap_or_default(),
                0.0,
                None,
            )
        }
        Basis::Weight(unit) | Basis::Unit(unit) => (
            resolve_status(need_total, have_total, any_entries, any_convertible),
            unit.clone(),
            need_total,
            any_convertible.then_some(have_total),
        ),
    };

    WAvailabilityGroupResult {
        key: group.key.clone(),
        basis_unit,
        need_value,
        have_value,
        status,
        shortfall: shortfall_for(need_value, have_value),
        sources,
    }
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/// Evaluate availability for a batch of ingredient groups in one call. Each
/// group is resolved independently; the caller shapes the results into
/// `IngredientAvailability` / `AggregatedNeed`.
#[wasm_bindgen]
pub fn evaluate_availability(input: WAvailabilityInput) -> WAvailabilityResult {
    WAvailabilityResult {
        groups: input.groups.iter().map(evaluate_group).collect(),
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::WUnitMapping;
    use rstest::rstest;

    #[test]
    fn status_for_reverdicts_against_a_reduced_need() {
        use WAvailabilityStatus::*;
        // The shopping-list case: excluding a meal lowers the need, and a row
        // that was short becomes ok without re-sending any inventory.
        assert_eq!(availability_status_for(100.0, Some(500.0), Short), Ok);
        assert_eq!(availability_status_for(600.0, Some(500.0), Ok), Short);
        assert_eq!(availability_status_for(600.0, Some(0.0), Ok), Missing);
    }

    #[test]
    fn status_for_keeps_the_prior_verdict_when_on_hand_is_unknown() {
        use WAvailabilityStatus::*;
        // None means "no inventory" OR "units don't reconcile"; only the
        // original evaluation knows which, so it must not be re-derived.
        assert_eq!(
            availability_status_for(5.0, None, Unconvertible),
            Unconvertible
        );
        assert_eq!(availability_status_for(5.0, None, Missing), Missing);
    }

    #[test]
    fn status_for_shares_the_evaluator_epsilon() {
        // An exact match must not flip to Short on float noise — the same
        // tolerance `resolve_status` applies, because it's the same function.
        assert_eq!(
            availability_status_for(0.1 + 0.2, Some(0.3), WAvailabilityStatus::Ok),
            WAvailabilityStatus::Ok
        );
    }

    #[test]
    fn shortfall_is_none_when_on_hand_is_unknown() {
        // Not zero, and not the whole need: an unconvertible row's shortfall is
        // genuinely unknown, and claiming the full need sorts an invented
        // number to the top of the buy list.
        assert_eq!(shortfall_for(500.0, None), None);
        assert_eq!(shortfall_for(500.0, Some(200.0)), Some(300.0));
        assert_eq!(shortfall_for(200.0, Some(500.0)), Some(0.0));
    }

    fn amt(value: f64, unit: &str) -> WAmount {
        WAmount {
            unit: unit.to_string(),
            value,
            upper_value: None,
        }
    }

    /// A product whose only edges are stored mappings (no food/price).
    fn product(
        id: &str,
        mappings: Vec<WUnitMapping>,
        on_hand: Vec<WAmount>,
    ) -> WAvailabilityProduct {
        WAvailabilityProduct {
            product: WProductInput {
                id: id.to_string(),
                price: None,
                unit_mappings: mappings,
                food: None,
            },
            on_hand,
        }
    }

    fn mapping(av: f64, au: &str, bv: f64, bu: &str) -> WUnitMapping {
        WUnitMapping {
            a: amt(av, au),
            b: amt(bv, bu),
            source: None,
            source_metadata: None,
        }
    }

    fn need(value: f64, unit: &str, line_index: u32) -> WAvailabilityNeed {
        WAvailabilityNeed {
            amount: amt(value, unit),
            line_index,
        }
    }

    fn eval(group: WAvailabilityGroup) -> WAvailabilityGroupResult {
        evaluate_group(&group)
    }

    #[test]
    fn gram_basis_ok_when_enough_on_hand() {
        // need 100 g, have 1 cup = 120 g → ok.
        let g = eval(WAvailabilityGroup {
            key: "k".into(),
            needs: vec![need(100.0, "g", 0)],
            products: vec![product(
                "p",
                vec![mapping(1.0, "cup", 120.0, "g")],
                vec![amt(1.0, "cup")],
            )],
        });
        assert_eq!(g.basis_unit, "g");
        assert_eq!(g.need_value, 100.0);
        assert_eq!(g.have_value, Some(120.0));
        assert_eq!(g.status, WAvailabilityStatus::Ok);
    }

    /// A sub-gram need must survive the conversion to the weight basis. When the
    /// unit engine rounded to whole grams, a 1 pinch need became 0 g — and
    /// `have_total + EPSILON >= 0` reported `Ok` no matter how little was on hand,
    /// so an empty shelf read as "you have enough".
    #[test]
    fn sub_gram_need_keeps_its_weight() {
        // 1 cup = 120 g ⇒ 1 tsp = 2.5 g ⇒ 1 pinch (1/16 tsp) = 0.15625 g.
        let g = eval(WAvailabilityGroup {
            key: "k".into(),
            needs: vec![need(1.0, "pinch", 0)],
            products: vec![product(
                "p",
                vec![mapping(1.0, "cup", 120.0, "g")],
                vec![amt(0.05, "g")],
            )],
        });
        assert_eq!(g.basis_unit, "g");
        assert_eq!(g.need_value, 0.15625);
        // 0.05 g on hand against a 0.15625 g need is short, not satisfied.
        assert_eq!(g.status, WAvailabilityStatus::Short);
    }

    #[test]
    fn short_when_some_but_not_enough() {
        let g = eval(WAvailabilityGroup {
            key: "k".into(),
            needs: vec![need(200.0, "g", 0)],
            products: vec![product(
                "p",
                vec![mapping(1.0, "cup", 120.0, "g")],
                vec![amt(1.0, "cup")],
            )],
        });
        assert_eq!(g.status, WAvailabilityStatus::Short);
        assert_eq!(g.have_value, Some(120.0));
    }

    #[test]
    fn missing_when_no_inventory() {
        let g = eval(WAvailabilityGroup {
            key: "k".into(),
            needs: vec![need(100.0, "g", 0)],
            products: vec![product("p", vec![mapping(1.0, "cup", 120.0, "g")], vec![])],
        });
        assert_eq!(g.status, WAvailabilityStatus::Missing);
        assert_eq!(g.have_value, None);
    }

    #[test]
    fn unconvertible_when_on_hand_unit_has_no_path() {
        // need grams, on hand in an unrelated unit with no weight path.
        let g = eval(WAvailabilityGroup {
            key: "k".into(),
            needs: vec![need(100.0, "g", 0)],
            products: vec![product("p", vec![], vec![amt(2.0, "clove")])],
        });
        // need has no weight path either → authored-unit basis "g"; the clove
        // on-hand doesn't match "g" → nothing convertible.
        assert_eq!(g.status, WAvailabilityStatus::Unconvertible);
    }

    #[test]
    fn authored_unit_basis_when_no_weight_path() {
        // No mappings: need "2 clove", on hand "5 clove" → same-unit compare, ok.
        let g = eval(WAvailabilityGroup {
            key: "k".into(),
            needs: vec![need(2.0, "clove", 0)],
            products: vec![product("p", vec![], vec![amt(5.0, "clove")])],
        });
        assert_eq!(g.basis_unit, "clove");
        assert_eq!(g.need_value, 2.0);
        assert_eq!(g.have_value, Some(5.0));
        assert_eq!(g.status, WAvailabilityStatus::Ok);
    }

    #[test]
    fn aggregated_needs_sum_in_grams_with_sources() {
        // two lines, 50 g + 100 g, have 1 cup = 120 g → need 150 > 120 → short.
        let g = eval(WAvailabilityGroup {
            key: "ing".into(),
            needs: vec![need(50.0, "g", 0), need(100.0, "g", 3)],
            products: vec![product(
                "p",
                vec![mapping(1.0, "cup", 120.0, "g")],
                vec![amt(1.0, "cup")],
            )],
        });
        assert_eq!(g.need_value, 150.0);
        assert_eq!(g.have_value, Some(120.0));
        assert_eq!(g.status, WAvailabilityStatus::Short);
        assert_eq!(g.sources.len(), 2);
        assert_eq!(g.sources[0].line_index, 0);
        assert_eq!(g.sources[0].need_value, 50.0);
        assert_eq!(g.sources[1].line_index, 3);
        assert_eq!(g.sources[1].need_value, 100.0);
    }

    #[test]
    fn inventory_counted_once_across_lines_not_per_line() {
        // Two lines needing 60 g each (120 total), 120 g on hand → exactly ok.
        // Summing inventory per-line would double it to 240 and wrongly pass big.
        let g = eval(WAvailabilityGroup {
            key: "ing".into(),
            needs: vec![need(60.0, "g", 0), need(60.0, "g", 1)],
            products: vec![product(
                "p",
                vec![mapping(1.0, "cup", 120.0, "g")],
                vec![amt(1.0, "cup")],
            )],
        });
        assert_eq!(g.need_value, 120.0);
        assert_eq!(g.have_value, Some(120.0));
        assert_eq!(g.status, WAvailabilityStatus::Ok);
    }

    #[test]
    fn mixed_units_are_incoherent_not_a_bogus_total() {
        // "2 cup" + "300 g" with no shared weight basis: the old TS summed
        // 2 + 300 = 302 "cup". Now → unconvertible, inventory not trusted, and
        // the meaningless sum is zeroed out (total AND per-source) so nothing
        // downstream can render "302" as a quantity.
        let g = eval(WAvailabilityGroup {
            key: "ing".into(),
            needs: vec![need(2.0, "cup", 0), need(300.0, "g", 1)],
            products: vec![product("p", vec![], vec![amt(2.0, "cup")])],
        });
        assert_eq!(g.status, WAvailabilityStatus::Unconvertible);
        assert_eq!(g.have_value, None);
        assert_eq!(g.need_value, 0.0); // not the bogus 302
        assert!(g.sources.iter().all(|s| s.need_value == 0.0));
        // line indices are preserved so the UI still knows which lines contributed.
        assert_eq!(g.sources.len(), 2);
        assert_eq!(g.sources[1].line_index, 1);
    }

    #[test]
    fn multi_product_completes_the_weight_path() {
        // need grams; product A supplies cup→g, on-hand lives on product B in cups.
        // The merged graph converts the need; B's own graph must also reach grams,
        // so both products carry the mapping here (mirrors the shared-graph need).
        let g = eval(WAvailabilityGroup {
            key: "ing".into(),
            needs: vec![need(100.0, "g", 0)],
            products: vec![
                product("a", vec![mapping(1.0, "cup", 120.0, "g")], vec![]),
                product(
                    "b",
                    vec![mapping(1.0, "cup", 120.0, "g")],
                    vec![amt(1.0, "cup")],
                ),
            ],
        });
        assert_eq!(g.have_value, Some(120.0));
        assert_eq!(g.status, WAvailabilityStatus::Ok);
    }

    /// Status monotonicity: across a grid of (need, have), status is never `Ok`
    /// when have < need (beyond epsilon), and more on-hand never downgrades the
    /// verdict. The invariant-style check the plan called out, table-driven so it
    /// needs no proptest dependency.
    #[rstest]
    #[case(100.0)]
    #[case(50.0)]
    #[case(0.5)]
    fn status_monotonic_in_on_hand(#[case] need_g: f64) {
        let rank = |s: WAvailabilityStatus| match s {
            WAvailabilityStatus::Missing | WAvailabilityStatus::Unconvertible => 0,
            WAvailabilityStatus::Short => 1,
            WAvailabilityStatus::Ok => 2,
        };
        let mut prev_rank = -1;
        let mut steps = 0;
        while steps <= 20 {
            let have_g = need_g * (steps as f64) / 10.0;
            let g = eval(WAvailabilityGroup {
                key: "k".into(),
                needs: vec![need(need_g, "g", 0)],
                products: vec![product(
                    "p",
                    vec![mapping(1.0, "g", 1.0, "g")],
                    vec![amt(have_g, "g")],
                )],
            });
            // never Ok when strictly short of the need
            if have_g + COVERAGE_EPSILON < need_g {
                assert_ne!(
                    g.status,
                    WAvailabilityStatus::Ok,
                    "ok at have={have_g} need={need_g}"
                );
            }
            assert!(
                rank(g.status) >= prev_rank,
                "status downgraded as on-hand grew"
            );
            prev_rank = rank(g.status);
            steps += 1;
        }
    }

    #[test]
    fn status_serde_matches_the_zod_contract() {
        // zod ingredientAvailabilityStatus (minus "subrecipe", caller-handled).
        assert_eq!(
            serde_json::to_value(WAvailabilityStatus::Ok).unwrap(),
            serde_json::json!("ok")
        );
        assert_eq!(
            serde_json::to_value(WAvailabilityStatus::Short).unwrap(),
            serde_json::json!("short")
        );
        assert_eq!(
            serde_json::to_value(WAvailabilityStatus::Missing).unwrap(),
            serde_json::json!("missing")
        );
        assert_eq!(
            serde_json::to_value(WAvailabilityStatus::Unconvertible).unwrap(),
            serde_json::json!("unconvertible")
        );
    }

    #[test]
    fn export_batches_groups_and_tolerates_an_empty_group() {
        // Drives the public `evaluate_availability` wrapper (not just
        // `evaluate_group`) and the defensive empty-needs basis.
        let result = evaluate_availability(WAvailabilityInput {
            groups: vec![
                WAvailabilityGroup {
                    key: "a".into(),
                    needs: vec![need(100.0, "g", 0)],
                    products: vec![product(
                        "p",
                        vec![mapping(1.0, "cup", 120.0, "g")],
                        vec![amt(1.0, "cup")],
                    )],
                },
                // No needs, no inventory — the empty-needs guard yields an inert
                // `Ok` (a zero requirement is satisfied) rather than panicking.
                WAvailabilityGroup {
                    key: "empty".into(),
                    needs: vec![],
                    products: vec![],
                },
            ],
        });
        assert_eq!(result.groups.len(), 2);
        assert_eq!(result.groups[0].key, "a");
        assert_eq!(result.groups[0].status, WAvailabilityStatus::Ok);
        assert_eq!(result.groups[1].key, "empty");
        assert_eq!(result.groups[1].need_value, 0.0);
        assert_eq!(result.groups[1].status, WAvailabilityStatus::Ok);
    }

    #[test]
    fn non_finite_values_are_dropped_not_propagated() {
        // A non-finite need/on-hand (e.g. Inf from broken data) must be dropped
        // before it poisons the total to Inf/NaN — the hardening guard. Use an
        // authored-unit basis so the raw f64 reaches the finite() filter without
        // going through the rational graph (which can't represent Inf).
        let g = eval(WAvailabilityGroup {
            key: "k".into(),
            needs: vec![need(50.0, "clove", 0), need(f64::INFINITY, "clove", 1)],
            products: vec![product(
                "p",
                vec![],
                vec![amt(10.0, "clove"), amt(f64::INFINITY, "clove")],
            )],
        });
        assert!(g.need_value.is_finite());
        assert_eq!(g.need_value, 50.0); // infinite need contribution dropped
        assert_eq!(g.have_value, Some(10.0)); // infinite on-hand dropped
    }
}
