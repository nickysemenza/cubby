//! Availability evaluator: "do I have what this needs, and what am I short?".
//!
//! The shared engine behind "what can I make?", the `find_cookable_recipes`
//! agent tool, and the meal-planning shopping list. Reconciliation runs on the
//! same kernel the costing engine uses (`reconcile::pairs_for_product` +
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

use ingredient::unit::{convert_measure_with_graph, make_graph, Measure, MeasureKind};
use serde::{Deserialize, Serialize};
use tsify_next::Tsify;
use wasm_bindgen::prelude::*;

use crate::food_mappings::WProductInput;
use crate::reconcile::pairs_for_product;
use crate::WAmount;

/// Tiny tolerance so float rounding doesn't flip an exact match to "short".
/// Mirrors the TS `COVERAGE_EPSILON`.
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
#[tsify(into_wasm_abi)]
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

/// Drop non-finite values before they enter a sum — a NaN/Inf from broken data
/// poisons every downstream total in f64, with no way to notice in TS.
fn finite(x: f64) -> Option<f64> {
    x.is_finite().then_some(x)
}

fn resolve_status(
    need_value: f64,
    have_total: f64,
    any_entries: bool,
    any_convertible: bool,
) -> WAvailabilityStatus {
    use WAvailabilityStatus::*;
    if !any_entries {
        Missing
    } else if !any_convertible {
        Unconvertible
    } else if have_total + COVERAGE_EPSILON >= need_value {
        Ok
    } else if have_total > 0.0 {
        Short
    } else {
        Missing
    }
}

fn evaluate_group(group: &WAvailabilityGroup) -> WAvailabilityGroupResult {
    // Per-product graphs (for on-hand, converted via the matching product's
    // mappings) plus the merged graph (for needs, which may bridge across
    // products) — the same split the TS service used.
    let product_pairs: Vec<Vec<(Measure, Measure)>> = group
        .products
        .iter()
        .map(|p| pairs_for_product(&p.product))
        .collect();
    let all_pairs: Vec<(Measure, Measure)> = product_pairs.iter().flatten().cloned().collect();
    let all_graph = make_graph(&all_pairs);
    let product_graphs: Vec<_> = product_pairs.iter().map(|p| make_graph(p)).collect();

    // Convert each need to weight. Gram basis only when EVERY need converts, so
    // contributions are summable in one unit (the gram-first rule).
    let weights: Vec<Option<Measure>> = group
        .needs
        .iter()
        .map(|n| {
            convert_measure_with_graph(&n.amount.to_measure(), MeasureKind::Weight, &all_graph)
        })
        .collect();
    let all_weight = !weights.is_empty() && weights.iter().all(Option::is_some);

    let basis = if all_weight {
        let unit = weights[0]
            .as_ref()
            .expect("all_weight ⇒ every weight is Some")
            .unit()
            .to_str()
            .into_owned();
        Basis::Weight(unit)
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
    // authored value — the same gram-first fallback as the TS service).
    let sources: Vec<WAvailabilitySource> = group
        .needs
        .iter()
        .enumerate()
        .map(|(i, n)| {
            let need_value = match &basis {
                Basis::Weight(_) => weights[i]
                    .as_ref()
                    .expect("all_weight ⇒ every weight is Some")
                    .value(),
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

    let (status, basis_unit, have_value) = match &basis {
        // Mixed units with no weight basis: surface as unconvertible rather than
        // a confident-but-wrong total (the bug class this enum removes).
        Basis::Incoherent => (
            WAvailabilityStatus::Unconvertible,
            group
                .needs
                .first()
                .map(|n| n.amount.unit.clone())
                .unwrap_or_default(),
            None,
        ),
        Basis::Weight(unit) | Basis::Unit(unit) => (
            resolve_status(need_total, have_total, any_entries, any_convertible),
            unit.clone(),
            any_convertible.then_some(have_total),
        ),
    };

    WAvailabilityGroupResult {
        key: group.key.clone(),
        basis_unit,
        need_value: need_total,
        have_value,
        status,
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
        // 2 + 300 = 302 "cup". Now → unconvertible, inventory not trusted.
        let g = eval(WAvailabilityGroup {
            key: "ing".into(),
            needs: vec![need(2.0, "cup", 0), need(300.0, "g", 1)],
            products: vec![product("p", vec![], vec![amt(2.0, "cup")])],
        });
        assert_eq!(g.status, WAvailabilityStatus::Unconvertible);
        assert_eq!(g.have_value, None);
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
}
