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

use ingredient::unit::{convert_measure_with_graph, Measure, MeasureGraph, MeasureKind};

use crate::food_mappings::{product_mappings, WProductInput};

/// The amount a row's measures resolve from: a mass amount when present (the
/// stated weight, resolved exactly via the unit engine's mass identity), else
/// the first written amount. `None` only for an amount-less row.
pub(crate) fn canonical_amount(amounts: &[Measure]) -> Option<&Measure> {
    amounts
        .iter()
        .find(|m| matches!(m.kind(), Ok(MeasureKind::Weight)))
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
/// `make_graph`. The single way both engines turn a product into graph edges.
pub(crate) fn pairs_for_product(product: &WProductInput) -> Vec<(Measure, Measure)> {
    product_mappings(product)
        .iter()
        .map(|m| m.to_pair())
        .collect()
}
