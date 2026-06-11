//! Consumption model: the recipe line is not always what you eat.
//!
//! Each row's usage role (classified by ingredient-parser from name/modifier/
//! rawLine/section name) maps to a per-measure plan: cost, weight, and
//! nutrients each resolve from one source. `plan_for` is the single table both
//! the totals engine and the per-row views consume — the constants are the
//! tuning knobs. Port of `USAGE_CONSUMPTION` in the old recipe-costing.ts.

use ingredient::usage::IngredientUsage;
use serde::{Deserialize, Serialize};
use tsify_next::Tsify;

/// Fraction of a fried dish's (raw) batter weight that ends up absorbed as oil
/// and actually eaten. Deep-fried dough takes on roughly 10–20% of its weight
/// in oil; 0.15 is a middle-ground guesstimate. NOTE: it's applied to *raw*
/// batter weight (before frying drives off water), so it deliberately folds the
/// evaporation effect into the constant — the single knob to turn for accuracy.
pub const FRY_OIL_ABSORPTION_FRACTION: f64 = 0.15;
/// "Salt to taste" ≈ 1% of dish weight — a standard seasoning rate.
pub const SEASONING_BASIS_FRACTION: f64 = 0.01;
/// Unmeasured "butter, for the pan": a flat ~10 g, nearly all of it eaten.
pub const PAN_GREASE_GRAMS: f64 = 10.0;
/// Unmeasured "parsley, for garnish": a flat ~5 g flourish.
pub const GARNISH_GRAMS: f64 = 5.0;
/// Unmeasured "flour, for dusting": adhered coating ≈ 5% of dish weight.
pub const DREDGE_BASIS_FRACTION: f64 = 0.05;
/// Measured dredging flour: only ~20% of the bowl ends up on the food.
pub const DREDGE_RETAINED_FRACTION: f64 = 0.2;
/// Measured marinade: ~15% clings to the food; the rest is discarded.
pub const MARINADE_RETAINED_FRACTION: f64 = 0.15;

/// Where one measure (cost, weight, or nutrients) of a row resolves from.
/// Serializes to the zod `componentSource` union: `{kind:"own-full"}`,
/// `{kind:"basis-fraction",fraction}`, … — the frozen explain wire contract.
#[derive(Tsify, Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum ComponentSource {
    /// The row's own amount, as written.
    OwnFull,
    /// A fraction of the own amount.
    OwnFraction { fraction: f64 },
    /// A fraction of the other rows' weight.
    BasisFraction { fraction: f64 },
    /// A fixed gram estimate.
    FlatGrams { grams: f64 },
    /// No basis at all (errors into missingByType).
    Missing,
}

/// How a row's three measures resolve (the zod `plan` object).
#[derive(Tsify, Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
pub struct PlanTrio {
    pub cost: ComponentSource,
    pub weight: ComponentSource,
    pub nutrients: ComponentSource,
}

impl PlanTrio {
    pub fn sources(&self) -> [ComponentSource; 3] {
        [self.cost, self.weight, self.nutrients]
    }

    /// True when any measure depends on the basis weight (or is a flat
    /// estimate) — these rows resolve in pass 2, after the basis is known, and
    /// their own amounts never enter the basis.
    pub fn is_deferred(&self) -> bool {
        self.sources().iter().any(|c| {
            matches!(
                c,
                ComponentSource::BasisFraction { .. } | ComponentSource::FlatGrams { .. }
            )
        })
    }

    /// True when any measure is adjusted away from the written amount ("est.").
    pub fn is_estimated(&self) -> bool {
        self.sources().iter().any(|c| {
            !matches!(c, ComponentSource::OwnFull | ComponentSource::Missing)
        })
    }

    /// Whether a row's own weight contributes to the basis other rows estimate
    /// from. Own-full only, deliberately: a measured marinade's *retained*
    /// grams are themselves an estimate, so they don't feed a sibling
    /// fry-oil's basis.
    pub fn contributes_to_basis(&self) -> bool {
        matches!(self.weight, ComponentSource::OwnFull)
    }
}

fn all(source: ComponentSource) -> PlanTrio {
    PlanTrio {
        cost: source,
        weight: source,
        nutrients: source,
    }
}

/// The consumption table, per usage × measured/unmeasured. Notable asymmetries:
/// - Measured frying oil ("2 quarts oil, for frying"): the amount is the POT
///   volume, not consumption — full cost (you bought it), absorbed weight and
///   nutrients (you ate ~15% of batter weight, not 7,700 kcal of oil).
/// - Measured marinade/dredging: full cost, fractional weight/nutrition (the
///   rest is discarded).
///
/// Exhaustive over `IngredientUsage`: adding a variant upstream without
/// deciding its consumption semantics here fails the build.
pub fn plan_for(usage: IngredientUsage, measured: bool) -> PlanTrio {
    use ComponentSource::{BasisFraction, FlatGrams, Missing, OwnFraction, OwnFull};
    match (usage, measured) {
        (IngredientUsage::Normal, true) => all(OwnFull),
        (IngredientUsage::Normal, false) => all(Missing),

        (IngredientUsage::FryingMedium, true) => PlanTrio {
            cost: OwnFull,
            weight: BasisFraction {
                fraction: FRY_OIL_ABSORPTION_FRACTION,
            },
            nutrients: BasisFraction {
                fraction: FRY_OIL_ABSORPTION_FRACTION,
            },
        },
        (IngredientUsage::FryingMedium, false) => all(BasisFraction {
            fraction: FRY_OIL_ABSORPTION_FRACTION,
        }),

        (IngredientUsage::Seasoning, true) => all(OwnFull),
        (IngredientUsage::Seasoning, false) => all(BasisFraction {
            fraction: SEASONING_BASIS_FRACTION,
        }),

        (IngredientUsage::PanGrease, true) => all(OwnFull),
        (IngredientUsage::PanGrease, false) => all(FlatGrams {
            grams: PAN_GREASE_GRAMS,
        }),

        (IngredientUsage::Garnish, true) => all(OwnFull),
        (IngredientUsage::Garnish, false) => all(FlatGrams {
            grams: GARNISH_GRAMS,
        }),

        (IngredientUsage::Dredging, true) => PlanTrio {
            cost: OwnFull,
            weight: OwnFraction {
                fraction: DREDGE_RETAINED_FRACTION,
            },
            nutrients: OwnFraction {
                fraction: DREDGE_RETAINED_FRACTION,
            },
        },
        (IngredientUsage::Dredging, false) => all(BasisFraction {
            fraction: DREDGE_BASIS_FRACTION,
        }),

        (IngredientUsage::Marinade, true) => PlanTrio {
            cost: OwnFull,
            weight: OwnFraction {
                fraction: MARINADE_RETAINED_FRACTION,
            },
            nutrients: OwnFraction {
                fraction: MARINADE_RETAINED_FRACTION,
            },
        },
        // An unmeasured marinade line has no estimable basis — leave it missing.
        (IngredientUsage::Marinade, false) => all(Missing),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ComponentSource::*;

    #[test]
    fn component_source_serde_matches_the_zod_contract() {
        assert_eq!(
            serde_json::to_value(OwnFull).unwrap(),
            serde_json::json!({"kind": "own-full"})
        );
        assert_eq!(
            serde_json::to_value(OwnFraction { fraction: 0.2 }).unwrap(),
            serde_json::json!({"kind": "own-fraction", "fraction": 0.2})
        );
        assert_eq!(
            serde_json::to_value(BasisFraction { fraction: 0.15 }).unwrap(),
            serde_json::json!({"kind": "basis-fraction", "fraction": 0.15})
        );
        assert_eq!(
            serde_json::to_value(FlatGrams { grams: 10.0 }).unwrap(),
            serde_json::json!({"kind": "flat-grams", "grams": 10.0})
        );
        assert_eq!(
            serde_json::to_value(Missing).unwrap(),
            serde_json::json!({"kind": "missing"})
        );
    }

    #[test]
    fn plan_table_matches_the_ts_engine() {
        use IngredientUsage::*;
        // measured
        assert_eq!(plan_for(Normal, true), all(OwnFull));
        assert_eq!(
            plan_for(FryingMedium, true),
            PlanTrio {
                cost: OwnFull,
                weight: BasisFraction { fraction: 0.15 },
                nutrients: BasisFraction { fraction: 0.15 },
            }
        );
        assert_eq!(plan_for(Seasoning, true), all(OwnFull));
        assert_eq!(plan_for(PanGrease, true), all(OwnFull));
        assert_eq!(plan_for(Garnish, true), all(OwnFull));
        assert_eq!(
            plan_for(Dredging, true),
            PlanTrio {
                cost: OwnFull,
                weight: OwnFraction { fraction: 0.2 },
                nutrients: OwnFraction { fraction: 0.2 },
            }
        );
        assert_eq!(
            plan_for(Marinade, true),
            PlanTrio {
                cost: OwnFull,
                weight: OwnFraction { fraction: 0.15 },
                nutrients: OwnFraction { fraction: 0.15 },
            }
        );
        // unmeasured
        assert_eq!(plan_for(Normal, false), all(Missing));
        assert_eq!(
            plan_for(FryingMedium, false),
            all(BasisFraction { fraction: 0.15 })
        );
        assert_eq!(
            plan_for(Seasoning, false),
            all(BasisFraction { fraction: 0.01 })
        );
        assert_eq!(plan_for(PanGrease, false), all(FlatGrams { grams: 10.0 }));
        assert_eq!(plan_for(Garnish, false), all(FlatGrams { grams: 5.0 }));
        assert_eq!(
            plan_for(Dredging, false),
            all(BasisFraction { fraction: 0.05 })
        );
        assert_eq!(plan_for(Marinade, false), all(Missing));
    }

    #[test]
    fn helper_predicates() {
        // Deferred: any basis-fraction or flat-grams measure.
        assert!(plan_for(IngredientUsage::FryingMedium, true).is_deferred());
        assert!(plan_for(IngredientUsage::Garnish, false).is_deferred());
        assert!(!plan_for(IngredientUsage::Normal, true).is_deferred());
        assert!(!plan_for(IngredientUsage::Marinade, true).is_deferred());

        // Estimated: any measure adjusted away from the written amount.
        assert!(plan_for(IngredientUsage::Marinade, true).is_estimated());
        assert!(plan_for(IngredientUsage::FryingMedium, true).is_estimated());
        assert!(!plan_for(IngredientUsage::Normal, true).is_estimated());
        assert!(!plan_for(IngredientUsage::Normal, false).is_estimated());

        // Basis: own-full weight only — a measured fry pot or retained marinade
        // never feeds a sibling's basis.
        assert!(plan_for(IngredientUsage::Normal, true).contributes_to_basis());
        assert!(plan_for(IngredientUsage::Seasoning, true).contributes_to_basis());
        assert!(!plan_for(IngredientUsage::FryingMedium, true).contributes_to_basis());
        assert!(!plan_for(IngredientUsage::Marinade, true).contributes_to_basis());
        assert!(!plan_for(IngredientUsage::Normal, false).contributes_to_basis());
    }
}
