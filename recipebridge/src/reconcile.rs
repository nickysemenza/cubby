//! Shared reconciliation kernel: the unit-resolution primitives common to the
//! costing engine and the availability evaluator.
//!
//! Both engines turn a product into conversion-graph edges the same way
//! (`pairs_for_product`) and resolve a written amount to a target kind with the
//! same canonical-preference + fallback rule (`canonical_amount` /
//! `convert_with_fallback`). Owning that here gives the two a single source of
//! truth for "how an amount becomes grams/cost/nutrients", instead of the
//! costing engine keeping it private while availability re-derives it in TS.
//!
//! Phase A is a pure extraction — the bodies are lifted verbatim from
//! `costing::engine`, so costing stays bit-identical. Hardening (newtypes,
//! coherence enum) layers on in a later pass.

use ingredient::unit::{Measure, MeasureGraph, MeasureKind, convert_measure_with_graph};

use crate::food_mappings::{WProductInput, product_mapping_pairs};

// TODO(upstream): `canonical_amount` and `convert_with_fallback` below are fully
// pure — they operate only on `ingredient::unit` types (Measure/MeasureGraph/
// MeasureKind/convert_measure_with_graph), with no cubby-domain coupling. They'd
// fit naturally in `ingredient::unit::conversion` (beside `convert_measure_with_graph`)
// where native tools could reuse them and they'd be tested next to `Measure`.
// Deferred: there's no native consumer today, and moving them spans the cubby /
// ingredient-parser repo boundary (CI builds recipebridge against ingredient-parser
// `main`, so the upstream change must land first). `pairs_for_product` stays here
// either way — it's cubby-coupled (products / food mappings).

/// The amount a row's measures resolve from: a mass amount when present (the
/// stated weight, resolved exactly via the unit engine's mass identity), else
/// the first written amount. `None` only for an amount-less row.
pub(crate) fn canonical_amount(amounts: &[Measure]) -> Option<&Measure> {
    amounts
        .iter()
        .find(|m| matches!(m.kind(), MeasureKind::Weight))
        .or_else(|| amounts.first())
}

/// Convert a set of written amounts to one target kind off a graph, preferring
/// the canonical (mass) amount and only falling back to another written amount
/// for a kind the canonical one genuinely can't reach. The shared conversion
/// primitive: the costing engine resolves each of a row's measures through this
/// so a row's weight, cost, and nutrients share one basis.
pub(crate) fn convert_with_fallback(
    amounts: &[Measure],
    graph: &MeasureGraph,
    kind: MeasureKind,
) -> Option<Measure> {
    canonical_amount(amounts)
        .and_then(|m| convert_measure_with_graph(m, kind.clone(), graph))
        .or_else(|| {
            amounts
                .iter()
                .find_map(|m| convert_measure_with_graph(m, kind.clone(), graph))
        })
}

/// One product's conversion-graph edges (stored rows + food edges + the
/// synthesized price edge), as `(Measure, Measure)` pairs ready for
/// `make_graph`. The single way both engines turn a product into graph edges —
/// delegates to `product_mapping_pairs`, which builds pairs without cloning the
/// stored mapping rows.
pub(crate) fn pairs_for_product(product: &WProductInput) -> Vec<(Measure, Measure)> {
    product_mapping_pairs(product)
}

#[cfg(test)]
mod tests {
    use super::*;
    use ingredient::unit::make_graph;

    /// `canonical_amount` prefers a mass amount over the first written amount, so a
    /// row's measures resolve off the stated weight (exact mass identity) rather
    /// than a volume that needs a density.
    #[test]
    fn canonical_amount_prefers_mass_over_first() {
        let amounts = [Measure::new("cup", 1.0), Measure::new("g", 50.0)];
        let c = canonical_amount(&amounts).expect("some amount");
        assert_eq!(
            c.unit().to_str(),
            "g",
            "the mass amount wins over the first"
        );
    }

    /// The fallback arm: when the canonical (mass) amount genuinely can't reach the
    /// target kind, another written amount that can is used. Graph has only a
    /// `cup → $` edge, so grams have no money path but the cup does.
    #[test]
    fn convert_with_fallback_uses_a_later_amount_when_canonical_cant_reach() {
        let graph = make_graph(&[(Measure::new("cup", 1.0), Measure::new("dollar", 2.0))]);
        // canonical_amount picks the gram (mass) amount; it can't reach money, so
        // the fallback resolves money via the cup amount instead.
        let amounts = [Measure::new("g", 100.0), Measure::new("cup", 1.0)];
        let money = convert_with_fallback(&amounts, &graph, MeasureKind::Money)
            .expect("falls back to the cup amount for money");
        assert!((money.value() - 2.0).abs() < 1e-9, "1 cup = $2");
    }

    /// No amount reaches the kind → `None` (not a panic, not a bogus value).
    #[test]
    fn convert_with_fallback_returns_none_when_nothing_reaches_the_kind() {
        let graph = make_graph(&[(Measure::new("cup", 1.0), Measure::new("g", 120.0))]);
        let amounts = [Measure::new("g", 100.0), Measure::new("cup", 1.0)];
        assert!(convert_with_fallback(&amounts, &graph, MeasureKind::Money).is_none());
    }
}
