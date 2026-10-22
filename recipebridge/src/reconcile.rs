//! Numeric reconciliation shared by recipe costing and availability.

/// Drop non-finite values before they enter a sum — a NaN/Inf from broken data
/// poisons every downstream f64 total (recipe price/weight/nutrients, availability
/// have-totals), with no way to notice in TS. Shared by both engines.
pub(crate) fn finite(x: f64) -> Option<f64> {
    x.is_finite().then_some(x)
}
