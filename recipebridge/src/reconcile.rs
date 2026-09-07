//! Shared reconciliation kernel: the unit-resolution primitives common to the
//! costing engine and the availability evaluator.
//!
//! Both engines turn a product into conversion-graph edges the same way
//! (`product_mapping_pairs`). Generic canonical selection and conversion fallback
//! come directly from `ingredient::unit` at each call site.

/// One product's conversion-graph edges (stored rows + food edges + the
/// synthesized price edge), as `(Measure, Measure)` pairs ready for `make_graph`.
/// The single way both engines turn a product into graph edges. Re-exported here
/// (defined in `food_mappings`) so the reconciliation kernel is the one import
/// site for the costing engine and availability evaluator.
pub(crate) use crate::food_mappings::product_mapping_pairs;
/// Drop non-finite values before they enter a sum — a NaN/Inf from broken data
/// poisons every downstream f64 total (recipe price/weight/nutrients, availability
/// have-totals), with no way to notice in TS. Shared by both engines.
pub(crate) fn finite(x: f64) -> Option<f64> {
    x.is_finite().then_some(x)
}
