//! Canonical nutrition/cost estimate arithmetic.
//!
//! TypeScript owns the nutrient catalog and projects records to named entries;
//! scaling and aggregation stay here so recipe, meal, and serving views share
//! one implementation of range and completeness semantics.

use serde::{Deserialize, Serialize};
use tsify_next::Tsify;
use wasm_bindgen::prelude::*;

#[derive(Tsify, Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[tsify(into_wasm_abi, from_wasm_abi)]
pub struct WEstimateCoverage {
    pub covered: u32,
    pub total: u32,
}

#[derive(Tsify, Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum WUnavailableReason {
    NoData,
    YieldMissing,
    Empty,
}

#[derive(Tsify, Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum WPendingReason {
    TotalsMissing,
    TotalsStale,
}

#[derive(Tsify, Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(tag = "status", rename_all = "lowercase")]
#[tsify(into_wasm_abi, from_wasm_abi)]
pub enum WMeasureEstimate {
    Complete {
        lower: f64,
        #[tsify(type = "number | null")]
        upper: Option<f64>,
        coverage: WEstimateCoverage,
    },
    Partial {
        lower: f64,
        #[tsify(type = "number | null")]
        upper: Option<f64>,
        coverage: WEstimateCoverage,
    },
    Unavailable {
        reason: WUnavailableReason,
    },
    Pending {
        reason: WPendingReason,
    },
}

impl WMeasureEstimate {
    pub(crate) fn known(lower: f64, upper: Option<f64>, covered: bool, total: u32) -> Self {
        let coverage = WEstimateCoverage {
            covered: u32::from(covered),
            total,
        };
        if covered {
            Self::Complete {
                lower,
                upper,
                coverage,
            }
        } else {
            Self::Partial {
                lower,
                upper,
                coverage,
            }
        }
    }
}

#[derive(Tsify, Serialize, Deserialize, Clone, Debug, PartialEq)]
#[tsify(into_wasm_abi, from_wasm_abi)]
pub struct WNamedEstimate {
    pub code: String,
    pub estimate: WMeasureEstimate,
}

#[derive(Tsify, Serialize, Deserialize, Clone, Debug, PartialEq)]
#[tsify(into_wasm_abi, from_wasm_abi)]
pub struct WNutritionTotals {
    pub cost: WMeasureEstimate,
    pub nutrition: Vec<WNamedEstimate>,
}

#[derive(Tsify, Serialize, Deserialize)]
#[serde(transparent)]
#[tsify(from_wasm_abi)]
pub struct WMeasureEstimates(pub Vec<WMeasureEstimate>);

#[derive(Tsify, Serialize, Deserialize)]
#[serde(transparent)]
#[tsify(into_wasm_abi, from_wasm_abi)]
pub struct WNamedEstimates(pub Vec<WNamedEstimate>);

#[derive(Tsify, Serialize, Deserialize)]
#[serde(transparent)]
#[tsify(from_wasm_abi)]
pub struct WNutritionTotalsList(pub Vec<WNutritionTotals>);

fn add_count(total: &mut u32, value: u32) {
    *total = total.saturating_add(value);
}

pub(crate) fn scale_estimate_impl(
    estimate: &WMeasureEstimate,
    lower_factor: f64,
    upper_factor: Option<f64>,
) -> WMeasureEstimate {
    let scale_known = |lower: f64, upper: Option<f64>, coverage: WEstimateCoverage| {
        let scaled_lower = lower * lower_factor;
        let scaled_upper = match (upper, upper_factor) {
            (Some(value), factor) => Some(value * factor.unwrap_or(lower_factor)),
            (None, Some(factor)) if factor != lower_factor => Some(lower * factor),
            _ => None,
        };
        (scaled_lower, scaled_upper, coverage)
    };

    match estimate {
        WMeasureEstimate::Complete {
            lower,
            upper,
            coverage,
        } => {
            let (lower, upper, coverage) = scale_known(*lower, *upper, *coverage);
            WMeasureEstimate::Complete {
                lower,
                upper,
                coverage,
            }
        }
        WMeasureEstimate::Partial {
            lower,
            upper,
            coverage,
        } => {
            let (lower, upper, coverage) = scale_known(*lower, *upper, *coverage);
            WMeasureEstimate::Partial {
                lower,
                upper,
                coverage,
            }
        }
        other => other.clone(),
    }
}

pub(crate) fn aggregate_estimates_impl(entries: &[WMeasureEstimate]) -> WMeasureEstimate {
    if entries.is_empty() {
        return WMeasureEstimate::Unavailable {
            reason: WUnavailableReason::Empty,
        };
    }

    let mut lower = 0.0;
    let mut upper = 0.0;
    let mut any_upper = false;
    let mut covered = 0_u32;
    let mut total = 0_u32;
    let mut known_count = 0_u32;
    let mut incomplete = false;
    let mut pending_reason = None;
    let mut unavailable_reason = None;

    for entry in entries {
        match entry {
            WMeasureEstimate::Complete {
                lower: value,
                upper: bound,
                coverage,
            } => {
                known_count = known_count.saturating_add(1);
                lower += value;
                upper += bound.unwrap_or(*value);
                any_upper |= bound.is_some();
                add_count(&mut covered, coverage.covered);
                add_count(&mut total, coverage.total);
            }
            WMeasureEstimate::Partial {
                lower: value,
                upper: bound,
                coverage,
            } => {
                known_count = known_count.saturating_add(1);
                incomplete = true;
                lower += value;
                upper += bound.unwrap_or(*value);
                any_upper |= bound.is_some();
                add_count(&mut covered, coverage.covered);
                add_count(&mut total, coverage.total);
            }
            WMeasureEstimate::Pending { reason } => {
                incomplete = true;
                add_count(&mut total, 1);
                pending_reason = Some(match (pending_reason, reason) {
                    (Some(WPendingReason::TotalsMissing), _)
                    | (_, WPendingReason::TotalsMissing) => WPendingReason::TotalsMissing,
                    _ => WPendingReason::TotalsStale,
                });
            }
            WMeasureEstimate::Unavailable { reason } => {
                incomplete = true;
                add_count(&mut total, 1);
                unavailable_reason = Some(match (unavailable_reason, reason) {
                    (None, reason) => *reason,
                    (Some(current), reason) if current == *reason => current,
                    _ => WUnavailableReason::NoData,
                });
            }
        }
    }

    if known_count > 0 {
        let upper = any_upper.then_some(upper);
        if incomplete || covered < total {
            WMeasureEstimate::Partial {
                lower,
                upper,
                coverage: WEstimateCoverage { covered, total },
            }
        } else {
            WMeasureEstimate::Complete {
                lower,
                upper,
                coverage: WEstimateCoverage { covered, total },
            }
        }
    } else if let Some(reason) = pending_reason {
        WMeasureEstimate::Pending { reason }
    } else {
        WMeasureEstimate::Unavailable {
            reason: unavailable_reason.unwrap_or(WUnavailableReason::NoData),
        }
    }
}

fn scale_totals_impl(
    totals: &WNutritionTotals,
    lower_factor: f64,
    upper_factor: Option<f64>,
) -> WNutritionTotals {
    WNutritionTotals {
        cost: scale_estimate_impl(&totals.cost, lower_factor, upper_factor),
        nutrition: totals
            .nutrition
            .iter()
            .map(|entry| WNamedEstimate {
                code: entry.code.clone(),
                estimate: scale_estimate_impl(&entry.estimate, lower_factor, upper_factor),
            })
            .collect(),
    }
}

#[wasm_bindgen]
pub fn scale_estimate(
    estimate: WMeasureEstimate,
    lower_factor: f64,
    upper_factor: Option<f64>,
) -> WMeasureEstimate {
    scale_estimate_impl(&estimate, lower_factor, upper_factor)
}

#[wasm_bindgen]
pub fn aggregate_estimates(entries: WMeasureEstimates) -> WMeasureEstimate {
    aggregate_estimates_impl(&entries.0)
}

#[wasm_bindgen]
pub fn scale_nutrition_totals(
    totals: WNutritionTotals,
    lower_factor: f64,
    upper_factor: Option<f64>,
) -> WNutritionTotals {
    scale_totals_impl(&totals, lower_factor, upper_factor)
}

#[wasm_bindgen]
pub fn scale_nutrition_estimates(
    entries: WNamedEstimates,
    lower_factor: f64,
    upper_factor: Option<f64>,
) -> WNamedEstimates {
    WNamedEstimates(
        entries
            .0
            .iter()
            .map(|entry| WNamedEstimate {
                code: entry.code.clone(),
                estimate: scale_estimate_impl(&entry.estimate, lower_factor, upper_factor),
            })
            .collect(),
    )
}

#[wasm_bindgen]
pub fn aggregate_nutrition_totals(entries: WNutritionTotalsList) -> WNutritionTotals {
    let cost = aggregate_estimates_impl(
        &entries
            .0
            .iter()
            .map(|entry| entry.cost.clone())
            .collect::<Vec<_>>(),
    );
    let codes = entries
        .0
        .iter()
        .flat_map(|totals| totals.nutrition.iter().map(|entry| entry.code.clone()))
        .fold(Vec::<String>::new(), |mut codes, code| {
            if !codes.contains(&code) {
                codes.push(code);
            }
            codes
        });
    let nutrition = codes
        .into_iter()
        .map(|code| {
            let estimates = entries
                .0
                .iter()
                .filter_map(|totals| {
                    totals
                        .nutrition
                        .iter()
                        .find(|entry| entry.code == code)
                        .map(|entry| entry.estimate.clone())
                })
                .collect::<Vec<_>>();
            WNamedEstimate {
                code,
                estimate: aggregate_estimates_impl(&estimates),
            }
        })
        .collect();
    WNutritionTotals { cost, nutrition }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn complete(lower: f64, upper: Option<f64>) -> WMeasureEstimate {
        WMeasureEstimate::Complete {
            lower,
            upper,
            coverage: WEstimateCoverage {
                covered: 1,
                total: 1,
            },
        }
    }

    #[test]
    fn scales_both_ends_of_a_range() {
        assert_eq!(
            scale_estimate_impl(&complete(10.0, Some(12.0)), 2.0, Some(3.0)),
            WMeasureEstimate::Complete {
                lower: 20.0,
                upper: Some(36.0),
                coverage: WEstimateCoverage {
                    covered: 1,
                    total: 1
                }
            }
        );
    }

    #[test]
    fn known_plus_pending_is_a_partial_known_sum() {
        assert_eq!(
            aggregate_estimates_impl(&[
                complete(4.0, None),
                WMeasureEstimate::Pending {
                    reason: WPendingReason::TotalsStale
                }
            ]),
            WMeasureEstimate::Partial {
                lower: 4.0,
                upper: None,
                coverage: WEstimateCoverage {
                    covered: 1,
                    total: 2
                }
            }
        );
    }

    #[test]
    fn nested_partial_keeps_its_zero_coverage_and_known_subtotal() {
        assert_eq!(
            aggregate_estimates_impl(&[
                WMeasureEstimate::Partial {
                    lower: 5.0,
                    upper: None,
                    coverage: WEstimateCoverage {
                        covered: 0,
                        total: 1,
                    },
                },
                WMeasureEstimate::Pending {
                    reason: WPendingReason::TotalsStale,
                },
            ]),
            WMeasureEstimate::Partial {
                lower: 5.0,
                upper: None,
                coverage: WEstimateCoverage {
                    covered: 0,
                    total: 2,
                },
            }
        );
    }

    #[test]
    fn pending_entries_stay_pending_without_known_values() {
        assert_eq!(
            aggregate_estimates_impl(&[
                WMeasureEstimate::Unavailable {
                    reason: WUnavailableReason::NoData
                },
                WMeasureEstimate::Pending {
                    reason: WPendingReason::TotalsMissing
                }
            ]),
            WMeasureEstimate::Pending {
                reason: WPendingReason::TotalsMissing
            }
        );
    }

    #[test]
    fn empty_aggregate_is_distinct_from_no_data() {
        assert_eq!(
            aggregate_estimates_impl(&[]),
            WMeasureEstimate::Unavailable {
                reason: WUnavailableReason::Empty
            }
        );
    }
}
