//! One-food nutrition calculation for meal logging.
//!
//! Product and ingredient amounts run through the recipe costing engine so the
//! merged-product conversion graph, label precedence, and per-product price
//! isolation stay identical to recipe rows. Recipe portions use the same unit
//! engine for yield ratios and the canonical estimate scaler for uncertainty.

use ingredient::unit::{Measure, MeasureKind, convert_with_fallback, make_graph};
use serde::{Deserialize, Serialize};
use tsify_next::Tsify;
use wasm_bindgen::prelude::*;

use crate::costing::{WNutrientTarget, resolve_mapped_food};
use crate::estimates::scale_totals_impl;
use crate::{
    WAmount, WEstimateCoverage, WMeasureEstimate, WNamedEstimate, WNutritionTotals, WProductInput,
    WUnavailableReason,
};

const BATCH_UNIT: &str = "cubbyfoodbatch";

#[derive(Tsify, Serialize, Deserialize)]
pub struct WManualNutrient {
    pub code: String,
    pub value: f64,
}

#[derive(Tsify, Serialize, Deserialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum WFoodYieldBasisKind {
    Actual,
    Estimated,
    Recipe,
    Missing,
}

#[derive(Tsify, Serialize, Deserialize)]
pub struct WFoodYieldBasis {
    pub kind: WFoodYieldBasisKind,
    #[serde(default)]
    #[tsify(type = "number | null")]
    pub lower_grams: Option<f64>,
    #[serde(default)]
    #[tsify(type = "number | null")]
    pub upper_grams: Option<f64>,
}

#[derive(Tsify, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum WFoodAmountSource {
    Mapped {
        products: Vec<WProductInput>,
    },
    Recipe {
        batch: WNutritionTotals,
        yield_basis: WFoodYieldBasis,
        #[serde(default)]
        #[tsify(type = "WAmount | null")]
        recipe_yield: Option<WAmount>,
        #[serde(default)]
        #[tsify(type = "number | null")]
        servings: Option<f64>,
        scale: f64,
    },
    Manual {
        nutrients: Vec<WManualNutrient>,
    },
    Unavailable,
}

#[derive(Tsify, Serialize, Deserialize)]
#[tsify(from_wasm_abi)]
pub struct WFoodAmountInput {
    #[serde(default)]
    #[tsify(type = "WAmount | null")]
    pub amount: Option<WAmount>,
    pub source: WFoodAmountSource,
    pub nutrient_targets: Vec<WNutrientTarget>,
}

#[derive(Tsify, Serialize, Deserialize)]
#[tsify(into_wasm_abi)]
pub struct WFoodAmountResult {
    pub totals: WNutritionTotals,
    #[serde(default)]
    #[tsify(type = "number | null")]
    pub grams: Option<f64>,
    pub weight: WMeasureEstimate,
    pub batch_share: WMeasureEstimate,
}

fn unavailable(reason: WUnavailableReason) -> WMeasureEstimate {
    WMeasureEstimate::Unavailable {
        reason,
        coverage: None,
    }
}

fn known(lower: f64, upper: Option<f64>) -> WMeasureEstimate {
    WMeasureEstimate::Complete {
        lower,
        upper: upper.filter(|value| value.is_finite() && *value > lower),
        coverage: WEstimateCoverage {
            covered: 1,
            total: 1,
        },
    }
}

fn unavailable_totals(targets: &[WNutrientTarget], reason: WUnavailableReason) -> WNutritionTotals {
    WNutritionTotals {
        cost: unavailable(reason),
        nutrition: targets
            .iter()
            .map(|target| WNamedEstimate {
                code: target.code.clone(),
                estimate: unavailable(reason),
            })
            .collect(),
    }
}

fn grams_from_estimate(weight: &WMeasureEstimate) -> Option<f64> {
    match weight {
        WMeasureEstimate::Complete {
            lower, upper: None, ..
        }
        | WMeasureEstimate::Partial {
            lower, upper: None, ..
        } if lower.is_finite() => Some(*lower),
        _ => None,
    }
}

fn weight_for_amount(amount: Option<&WAmount>) -> WMeasureEstimate {
    let Some(amount) = amount else {
        return unavailable(WUnavailableReason::NoData);
    };
    let measures = [amount.to_measure()];
    let Some(weight) = convert_with_fallback(&measures, &make_graph(&[]), MeasureKind::Weight)
    else {
        return unavailable(WUnavailableReason::NoData);
    };
    if !weight.value().is_finite() {
        return unavailable(WUnavailableReason::NoData);
    }
    known(weight.value(), weight.upper_value())
}

fn mapped_food(
    amount: Option<WAmount>,
    products: Vec<WProductInput>,
    targets: Vec<WNutrientTarget>,
) -> Result<WFoodAmountResult, String> {
    let Some(amount) = amount else {
        return Ok(WFoodAmountResult {
            totals: unavailable_totals(&targets, WUnavailableReason::NoData),
            grams: None,
            weight: unavailable(WUnavailableReason::NoData),
            batch_share: unavailable(WUnavailableReason::NoData),
        });
    };
    let (totals, weight) = resolve_mapped_food(&amount, &products, &targets);
    Ok(WFoodAmountResult {
        totals,
        grams: grams_from_estimate(&weight),
        weight,
        batch_share: unavailable(WUnavailableReason::NoData),
    })
}

fn ratio_from_yield(amount: &WAmount, recipe_yield: &WAmount) -> Option<(f64, Option<f64>)> {
    if !recipe_yield.value.is_finite() || recipe_yield.value <= 0.0 {
        return None;
    }
    let pairs = [(recipe_yield.to_measure(), Measure::new(BATCH_UNIT, 1.0))];
    let measures = [amount.to_measure()];
    let ratio = convert_with_fallback(
        &measures,
        &make_graph(&pairs),
        MeasureKind::Other(BATCH_UNIT.to_string()),
    )?;
    (ratio.value().is_finite() && ratio.value() > 0.0)
        .then_some((ratio.value(), ratio.upper_value()))
}

fn scale_amount(amount: &WAmount, factor: f64) -> WAmount {
    WAmount {
        value: amount.value * factor,
        upper_value: amount.upper_value.map(|upper| upper * factor),
        unit: amount.unit.clone(),
    }
}

fn recipe_factor(
    amount: &WAmount,
    yield_basis: &WFoodYieldBasis,
    recipe_yield: Option<&WAmount>,
    servings: Option<f64>,
    scale: f64,
) -> Result<(f64, Option<f64>), WUnavailableReason> {
    if !scale.is_finite() || scale <= 0.0 {
        return Err(WUnavailableReason::YieldMissing);
    }

    let one_batch = WAmount {
        value: 1.0,
        upper_value: None,
        unit: "batch".to_string(),
    };
    if let Some(factor) = ratio_from_yield(amount, &one_batch) {
        return Ok(factor);
    }

    if let Some(servings) = servings.filter(|value| value.is_finite() && *value > 0.0) {
        let current_servings = WAmount {
            value: servings * scale,
            upper_value: None,
            unit: "serving".to_string(),
        };
        if let Some(factor) = ratio_from_yield(amount, &current_servings) {
            return Ok(factor);
        }
    }

    let measures = [amount.to_measure()];
    if let Some(weight) = convert_with_fallback(&measures, &make_graph(&[]), MeasureKind::Weight) {
        let Some((lower, upper)) = yield_basis.bounds() else {
            return Err(WUnavailableReason::YieldMissing);
        };
        let factor_lower = weight.value() / upper.unwrap_or(lower);
        let factor_upper = weight.value() / lower;
        if factor_lower.is_finite() && factor_lower > 0.0 && factor_upper.is_finite() {
            return Ok((
                factor_lower,
                (factor_upper > factor_lower).then_some(factor_upper),
            ));
        }
        return Err(WUnavailableReason::YieldMissing);
    }

    let Some(recipe_yield) = recipe_yield else {
        return Err(WUnavailableReason::YieldMissing);
    };
    ratio_from_yield(amount, &scale_amount(recipe_yield, scale)).ok_or(WUnavailableReason::NoData)
}

impl WFoodYieldBasis {
    fn bounds(&self) -> Option<(f64, Option<f64>)> {
        if self.kind == WFoodYieldBasisKind::Missing {
            return None;
        }
        let lower = self
            .lower_grams
            .filter(|value| value.is_finite() && *value > 0.0)?;
        let upper = self
            .upper_grams
            .filter(|value| value.is_finite() && *value >= lower);
        Some((lower, upper))
    }
}

fn recipe_weight(
    amount: &WAmount,
    yield_basis: &WFoodYieldBasis,
    factor: (f64, Option<f64>),
) -> WMeasureEstimate {
    let direct = weight_for_amount(Some(amount));
    if matches!(direct, WMeasureEstimate::Complete { .. }) {
        return direct;
    }
    let Some((basis_lower, basis_upper)) = yield_basis.bounds() else {
        return unavailable(WUnavailableReason::YieldMissing);
    };
    let lower = basis_lower * factor.0;
    let upper_factor = factor.1.unwrap_or(factor.0);
    let upper = basis_upper.unwrap_or(basis_lower) * upper_factor;
    known(lower, (upper > lower).then_some(upper))
}

fn recipe_food(
    amount: Option<WAmount>,
    batch: WNutritionTotals,
    yield_basis: WFoodYieldBasis,
    recipe_yield: Option<WAmount>,
    servings: Option<f64>,
    scale: f64,
) -> WFoodAmountResult {
    let Some(amount) = amount else {
        return WFoodAmountResult {
            totals: unavailable_totals_from(&batch, WUnavailableReason::NoData),
            grams: None,
            weight: unavailable(WUnavailableReason::NoData),
            batch_share: unavailable(WUnavailableReason::NoData),
        };
    };
    let factor = match recipe_factor(
        &amount,
        &yield_basis,
        recipe_yield.as_ref(),
        servings,
        scale,
    ) {
        Ok(factor) => factor,
        Err(reason) => {
            let weight = weight_for_amount(Some(&amount));
            return WFoodAmountResult {
                totals: unavailable_totals_from(&batch, reason),
                grams: grams_from_estimate(&weight),
                weight,
                batch_share: unavailable(reason),
            };
        }
    };
    let weight = recipe_weight(&amount, &yield_basis, factor);
    WFoodAmountResult {
        totals: scale_totals_impl(&batch, factor.0, factor.1),
        grams: grams_from_estimate(&weight),
        weight,
        batch_share: known(factor.0, factor.1),
    }
}

fn unavailable_totals_from(
    totals: &WNutritionTotals,
    reason: WUnavailableReason,
) -> WNutritionTotals {
    WNutritionTotals {
        cost: unavailable(reason),
        nutrition: totals
            .nutrition
            .iter()
            .map(|entry| WNamedEstimate {
                code: entry.code.clone(),
                estimate: unavailable(reason),
            })
            .collect(),
    }
}

fn manual_food(
    amount: Option<&WAmount>,
    nutrients: Vec<WManualNutrient>,
    targets: &[WNutrientTarget],
) -> WFoodAmountResult {
    let weight = weight_for_amount(amount);
    let totals = WNutritionTotals {
        cost: unavailable(WUnavailableReason::NoData),
        nutrition: targets
            .iter()
            .map(|target| {
                let estimate = nutrients
                    .iter()
                    .find(|nutrient| nutrient.code == target.code)
                    .filter(|nutrient| nutrient.value.is_finite() && nutrient.value >= 0.0)
                    .map_or_else(
                        || unavailable(WUnavailableReason::NoData),
                        |nutrient| known(nutrient.value, None),
                    );
                WNamedEstimate {
                    code: target.code.clone(),
                    estimate,
                }
            })
            .collect(),
    };
    WFoodAmountResult {
        totals,
        grams: grams_from_estimate(&weight),
        weight,
        batch_share: unavailable(WUnavailableReason::NoData),
    }
}

pub fn calculate_food_amount_impl(input: WFoodAmountInput) -> Result<WFoodAmountResult, String> {
    let WFoodAmountInput {
        amount,
        source,
        nutrient_targets,
    } = input;
    match source {
        WFoodAmountSource::Mapped { products } => mapped_food(amount, products, nutrient_targets),
        WFoodAmountSource::Recipe {
            batch,
            yield_basis,
            recipe_yield,
            servings,
            scale,
        } => Ok(recipe_food(
            amount,
            batch,
            yield_basis,
            recipe_yield,
            servings,
            scale,
        )),
        WFoodAmountSource::Manual { nutrients } => {
            Ok(manual_food(amount.as_ref(), nutrients, &nutrient_targets))
        }
        WFoodAmountSource::Unavailable => {
            // A direct mass remains knowable from the canonical amount even
            // after its source row is deleted; source-relative conversions and
            // every nutrient/cost stay unavailable.
            let weight = weight_for_amount(amount.as_ref());
            Ok(WFoodAmountResult {
                totals: unavailable_totals(&nutrient_targets, WUnavailableReason::NoData),
                grams: grams_from_estimate(&weight),
                weight,
                batch_share: unavailable(WUnavailableReason::NoData),
            })
        }
    }
}

#[wasm_bindgen]
pub fn calculate_food_amount(input: WFoodAmountInput) -> Result<WFoodAmountResult, String> {
    calculate_food_amount_impl(input)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        WFoodInput, WFoodServing, WNutrientPer100, WPendingReason, WProductInput, WUnitMapping,
    };

    fn amount(value: f64, unit: &str) -> WAmount {
        WAmount {
            value,
            upper_value: None,
            unit: unit.to_string(),
        }
    }

    fn target(code: &str, unit: &str) -> WNutrientTarget {
        WNutrientTarget {
            code: code.to_string(),
            unit: unit.to_string(),
        }
    }

    fn complete(value: f64) -> WMeasureEstimate {
        known(value, None)
    }

    fn batch() -> WNutritionTotals {
        WNutritionTotals {
            cost: complete(20.0),
            nutrition: vec![WNamedEstimate {
                code: "208".to_string(),
                estimate: complete(1_000.0),
            }],
        }
    }

    fn basis(lower: f64, upper: Option<f64>) -> WFoodYieldBasis {
        WFoodYieldBasis {
            kind: WFoodYieldBasisKind::Recipe,
            lower_grams: Some(lower),
            upper_grams: upper,
        }
    }

    #[test]
    fn mapped_food_uses_the_costing_engine_graph() {
        let result = calculate_food_amount_impl(WFoodAmountInput {
            amount: Some(amount(0.5, "cup")),
            source: WFoodAmountSource::Mapped {
                products: vec![WProductInput {
                    id: "product".to_string(),
                    price: Some(4.0),
                    unit_mappings: vec![
                        WUnitMapping {
                            a: amount(1.0, "each"),
                            b: amount(200.0, "g"),
                            source: None,
                            source_metadata: None,
                        },
                        WUnitMapping {
                            a: amount(1.0, "cup"),
                            b: amount(100.0, "g"),
                            source: None,
                            source_metadata: None,
                        },
                    ],
                    food: Some(WFoodInput {
                        fdc_id: 1,
                        portions: vec![],
                        serving: None,
                        nutrients_per_100: vec![WNutrientPer100 {
                            unit: "kcal".to_string(),
                            amount: 300.0,
                        }],
                    }),
                }],
            },
            nutrient_targets: vec![target("208", "kcal")],
        })
        .unwrap();
        assert_eq!(result.grams, Some(50.0));
        assert_eq!(result.weight, complete(50.0));
        assert_eq!(result.totals.cost, complete(1.0));
        assert_eq!(result.totals.nutrition[0].estimate, complete(150.0));
    }

    #[test]
    fn label_serving_weight_overrides_stored_and_usda_servings() {
        let result = calculate_food_amount_impl(WFoodAmountInput {
            amount: Some(amount(1.0, "serving")),
            source: WFoodAmountSource::Mapped {
                products: vec![WProductInput {
                    id: "product".to_string(),
                    price: None,
                    unit_mappings: vec![
                        WUnitMapping {
                            a: amount(1.0, "serving"),
                            b: amount(35.0, "g"),
                            source: None,
                            source_metadata: None,
                        },
                        WUnitMapping {
                            a: amount(1.0, "serving"),
                            b: amount(30.0, "g"),
                            source: Some("label serving".to_string()),
                            source_metadata: None,
                        },
                    ],
                    food: Some(WFoodInput {
                        fdc_id: 1,
                        portions: vec![],
                        serving: Some(WFoodServing {
                            serving_size: Some(40.0),
                            serving_size_unit: Some("g".to_string()),
                            household_serving_fulltext: Some("1 serving".to_string()),
                        }),
                        nutrients_per_100: vec![WNutrientPer100 {
                            unit: "kcal".to_string(),
                            amount: 400.0,
                        }],
                    }),
                }],
            },
            nutrient_targets: vec![target("208", "kcal")],
        })
        .unwrap();
        assert_eq!(result.grams, Some(30.0));
        assert_eq!(result.totals.nutrition[0].estimate, complete(120.0));
    }

    #[test]
    fn servings_follow_the_live_scaled_serving_count() {
        let result = recipe_food(
            Some(amount(2.0, "servings")),
            batch(),
            basis(800.0, None),
            None,
            Some(8.0),
            2.0,
        );
        assert_eq!(result.batch_share, complete(0.125));
        assert_eq!(result.weight, complete(100.0));
        assert_eq!(result.grams, Some(100.0));
        assert_eq!(result.totals.nutrition[0].estimate, complete(125.0));
    }

    #[test]
    fn gram_amount_stays_exact_while_a_ranged_yield_ranges_the_share() {
        let result = recipe_food(
            Some(amount(100.0, "g")),
            batch(),
            basis(800.0, Some(1_000.0)),
            Some(WAmount {
                value: 800.0,
                upper_value: Some(1_000.0),
                unit: "g".to_string(),
            }),
            None,
            1.0,
        );
        assert_eq!(result.weight, complete(100.0));
        assert_eq!(result.grams, Some(100.0));
        assert_eq!(result.batch_share, known(0.1, Some(0.125)));
        assert_eq!(
            result.totals.nutrition[0].estimate,
            known(100.0, Some(125.0))
        );
    }

    #[test]
    fn declared_volume_yield_preserves_ratio_uncertainty() {
        let result = recipe_food(
            Some(amount(2.0, "cup")),
            batch(),
            basis(900.0, None),
            Some(WAmount {
                value: 8.0,
                upper_value: Some(10.0),
                unit: "cup".to_string(),
            }),
            None,
            1.0,
        );
        assert_eq!(result.batch_share, known(0.2, Some(0.25)));
        assert_eq!(result.weight, known(180.0, Some(225.0)));
        assert_eq!(result.grams, None);
    }

    #[test]
    fn manual_nutrients_are_absolute_even_when_weight_is_present() {
        let result = manual_food(
            Some(&amount(250.0, "g")),
            vec![WManualNutrient {
                code: "208".to_string(),
                value: 400.0,
            }],
            &[target("208", "kcal")],
        );
        assert_eq!(result.grams, Some(250.0));
        assert_eq!(result.totals.nutrition[0].estimate, complete(400.0));
    }

    #[test]
    fn unknown_units_return_unavailable_instead_of_erroring() {
        let result = recipe_food(
            Some(amount(1.0, "mystery ladle")),
            batch(),
            basis(800.0, None),
            Some(amount(4.0, "cup")),
            None,
            1.0,
        );
        assert!(matches!(
            result.batch_share,
            WMeasureEstimate::Unavailable {
                reason: WUnavailableReason::YieldMissing,
                ..
            } | WMeasureEstimate::Unavailable {
                reason: WUnavailableReason::NoData,
                ..
            }
        ));
    }

    #[test]
    fn pending_batch_totals_stay_pending_when_scaled() {
        let batch = WNutritionTotals {
            cost: WMeasureEstimate::Pending {
                reason: WPendingReason::TotalsStale,
            },
            nutrition: vec![WNamedEstimate {
                code: "208".to_string(),
                estimate: WMeasureEstimate::Pending {
                    reason: WPendingReason::TotalsMissing,
                },
            }],
        };
        let result = recipe_food(
            Some(amount(1.0, "batch")),
            batch,
            basis(500.0, None),
            None,
            None,
            1.0,
        );
        assert!(matches!(
            result.totals.cost,
            WMeasureEstimate::Pending {
                reason: WPendingReason::TotalsStale
            }
        ));
    }
}
