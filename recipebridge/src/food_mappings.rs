//! Unit-mapping synthesis from product + USDA food data.
//!
//! Port of the synthesis half of `apps/web/src/lib/unit-mapping-utils.ts` — the
//! TS module is now a thin wrapper over the `unit_mappings_from_food` /
//! `product_unit_mappings` exports below. The recipe-costing engine consumes
//! `product_mappings` directly, so client display, server totals, and costing
//! all derive conversion edges from this single implementation.
//!
//! Pure serde + parser code (no JsValue except the export shims) so
//! `cargo test` runs natively.

use ingredient::{
    from_str as parse_ingredient_str,
    unit::{Measure, singular},
};
use serde::{Deserialize, Serialize};
use tsify_next::Tsify;
use wasm_bindgen::prelude::*;

use crate::{WAmount, WUnitMapping, WUnitMappings};

// ---------------------------------------------------------------------------
// Boundary types
// ---------------------------------------------------------------------------

/// One USDA food portion row (the mapping-relevant subset of `FoodPortion`).
#[derive(Tsify, Serialize, Deserialize)]
#[tsify(from_wasm_abi)]
pub struct WFoodPortion {
    pub amount: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[tsify(optional, type = "string | null")]
    pub modifier: Option<String>,
    pub gram_weight: f64,
}

/// Branded-food serving metadata, nullable fields straight off the USDA row.
#[derive(Tsify, Serialize, Deserialize)]
#[tsify(from_wasm_abi)]
pub struct WFoodServing {
    #[serde(default)]
    #[tsify(type = "number | null")]
    pub serving_size: Option<f64>,
    #[serde(default)]
    #[tsify(type = "string | null")]
    pub serving_size_unit: Option<String>,
    #[serde(default)]
    #[tsify(type = "string | null")]
    pub household_serving_fulltext: Option<String>,
}

/// One nutrient amount per 100 g. Pre-filtered (tier-1 only) and pre-labeled by
/// TS — `unit` is the conversion target string ("g protein", "mg sodium",
/// "kcal"), keeping `TIER1_NUTRIENTS` TS-owned.
#[derive(Tsify, Serialize, Deserialize)]
#[tsify(from_wasm_abi)]
pub struct WNutrientPer100 {
    pub unit: String,
    pub amount: f64,
}

/// The mapping-relevant subset of a USDA `FoodSummary`.
#[derive(Tsify, Serialize, Deserialize)]
#[tsify(from_wasm_abi)]
pub struct WFoodInput {
    pub fdc_id: u32,
    pub portions: Vec<WFoodPortion>,
    #[serde(default)]
    #[tsify(type = "WFoodServing | null")]
    pub serving: Option<WFoodServing>,
    pub nutrients_per_100: Vec<WNutrientPer100>,
}

/// A product as mapping synthesis sees it: stored mapping rows plus the data
/// synthesized edges derive from. All fields required on purpose (mirrors the
/// TS `getAllUnitMappingsFromProduct` contract): omitting one would silently
/// drop a synthesized edge.
#[derive(Tsify, Serialize, Deserialize)]
#[tsify(from_wasm_abi)]
pub struct WProductInput {
    pub id: String,
    #[serde(default)]
    #[tsify(type = "number | null")]
    pub price: Option<f64>,
    /// Stored DB rows — pass through verbatim, keeping their own metadata.
    pub unit_mappings: Vec<WUnitMapping>,
    #[serde(default)]
    #[tsify(type = "WFoodInput | null")]
    pub food: Option<WFoodInput>,
}

/// Provenance of a mapping (mirrors the TS `sourceMetadata` discriminated union
/// in `@cubby/schemas/unitmapping` — same tag + field names).
#[derive(Tsify, Serialize, Deserialize, Clone, Debug, PartialEq)]
#[tsify(into_wasm_abi, from_wasm_abi)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum WSourceMetadata {
    Product {
        #[serde(rename = "productId")]
        product_id: String,
    },
    Food {
        #[serde(rename = "fdcId")]
        fdc_id: u32,
    },
    Manual,
}

// ---------------------------------------------------------------------------
// Synthesis
// ---------------------------------------------------------------------------

fn amount(value: f64, unit: impl Into<String>) -> WAmount {
    WAmount {
        unit: unit.into(),
        value,
        upper_value: None,
    }
}

/// Normalize USDA branded serving-size units to graph units. Unknown values
/// (anything outside the `branded_food_serving_size_unit` enum) skip the
/// mapping entirely — the TS zod-parse-throw behavior.
fn normalize_serving_size_unit(unit: &str) -> Option<&str> {
    match unit {
        "GM" | "GRM" => Some("g"),
        "MC" | "MLT" => Some("ml"),
        "g" | "IU" | "MG" | "ml" => Some(unit),
        _ => None,
    }
}

/// Serving-size mapping from branded food info, household text parsed by the
/// ingredient parser. `None` when any field is null or unparseable.
fn serving_mapping(fdc_id: u32, serving: &WFoodServing) -> Option<WUnitMapping> {
    let serving_size = serving.serving_size?;
    let unit_raw = serving.serving_size_unit.as_deref()?;
    let household = serving.household_serving_fulltext.as_deref()?;

    let parsed = parse_ingredient_str(household);
    let mut b = WAmount::from(parsed.amounts.last()?);

    // INVARIANT: bare counts may enter the conversion graph only from *recipe
    // amounts*, never from serving metadata. In the unit graph "whole" ≡ "each"
    // ≡ the priced item, so emitting a bare serving COUNT here would let a
    // serving inherit the product's per-item price (e.g. ProMix fdc 576208:
    // household "2 SCOOPS" parses to `2 ⟨whole⟩` + name "SCOOPS" — unguarded,
    // 44.3 g = 2 whole made one scoop cost a whole $39.99 bag). Relabel the
    // bare count with the household word the parser read as the "name" —
    // through the parser's own `singular`, so the emitted unit matches exactly
    // how that word parses on a recipe line — falling back to a generic
    // "serving" unit.
    if b.unit == "whole" || b.unit.is_empty() {
        let household_unit = singular(parsed.name.trim());
        b.unit = if household_unit.is_empty() {
            "serving".to_string()
        } else {
            household_unit.into_owned()
        };
    }

    Some(WUnitMapping {
        a: amount(serving_size, normalize_serving_size_unit(unit_raw)?),
        b,
        source: Some("USDA FDC serving".to_string()),
        source_metadata: Some(WSourceMetadata::Food { fdc_id }),
    })
}

/// USDA portion row → weight mapping.
fn portion_mapping(p: &WFoodPortion, fdc_id: u32) -> WUnitMapping {
    WUnitMapping {
        a: amount(p.amount, p.modifier.as_deref().unwrap_or("portion")),
        b: amount(p.gram_weight, "g"),
        source: Some("USDA portion".to_string()),
        source_metadata: Some(WSourceMetadata::Food { fdc_id }),
    }
}

/// Per-nutrient `100 g = X <target>` edges (e.g. `100 g = 15 g protein`).
fn nutrition_mappings(food: &WFoodInput) -> impl Iterator<Item = WUnitMapping> + '_ {
    food.nutrients_per_100
        .iter()
        .filter(|n| n.amount > 0.0)
        .map(|n| WUnitMapping {
            a: amount(100.0, "g"),
            b: amount(n.amount, n.unit.clone()),
            source: Some("USDA nutrition".to_string()),
            source_metadata: Some(WSourceMetadata::Food {
                fdc_id: food.fdc_id,
            }),
        })
}

/// All mappings derivable from one USDA food: portions, the (guarded) branded
/// serving edge, and per-nutrient edges — in that order, matching the TS port.
pub fn mappings_from_food(food: &WFoodInput) -> Vec<WUnitMapping> {
    food.portions
        .iter()
        .map(|p| portion_mapping(p, food.fdc_id))
        .chain(
            food.serving
                .as_ref()
                .and_then(|s| serving_mapping(food.fdc_id, s)),
        )
        .chain(nutrition_mappings(food))
        .collect()
}

/// The synthetic `1 each = $price` costing edge. Price lives on the scalar
/// `product.price` column (source of truth), projected into the graph at
/// compute time — same read-time synthesis as the USDA edges.
///
/// The shared `each` anchor is the collision point for the multi-priced-product
/// hazard documented on `engine.rs` (`Engine::new`): every product's price edge
/// lands on the same `each` node, so two priced products on one ingredient yield
/// two `each → dollar` edges the conversion picks between arbitrarily.
fn price_mapping(price: Option<f64>, product_id: &str) -> Option<WUnitMapping> {
    let price = price?;
    Some(WUnitMapping {
        a: amount(1.0, "each"),
        b: amount(price, "dollar"),
        source: Some("price".to_string()),
        source_metadata: Some(WSourceMetadata::Product {
            product_id: product_id.to_string(),
        }),
    })
}

/// All unit mappings for a product: stored rows (verbatim, keeping their own
/// metadata), food-derived edges, then the synthesized price edge.
pub fn product_mappings(product: &WProductInput) -> Vec<WUnitMapping> {
    product
        .unit_mappings
        .iter()
        .cloned()
        .chain(
            product
                .food
                .as_ref()
                .map(mappings_from_food)
                .unwrap_or_default(),
        )
        .chain(price_mapping(product.price, &product.id))
        .collect()
}

/// One product's conversion-graph edges as `(Measure, Measure)` pairs — what the
/// costing + availability engines actually consume. Unlike `product_mappings`
/// (which clones the stored rows to return owned `WUnitMapping`s for the public
/// export), the stored rows are borrowed straight to pairs; only the food + price
/// edges are synthesized. Same edges, same order as `product_mappings`.
pub(crate) fn product_mapping_pairs(product: &WProductInput) -> Vec<(Measure, Measure)> {
    let food = product
        .food
        .as_ref()
        .map(mappings_from_food)
        .unwrap_or_default();
    let price = price_mapping(product.price, &product.id);
    product
        .unit_mappings
        .iter()
        .chain(food.iter())
        .chain(price.iter())
        .map(WUnitMapping::to_pair)
        .collect()
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

/// All unit mappings derivable from one USDA food: portion edges, the
/// (bare-count-guarded) branded serving edge, and per-nutrient `100 g = X`
/// edges. The TS `unitMappingsFromFood` is a thin wrapper over this.
#[wasm_bindgen]
pub fn unit_mappings_from_food(food: WFoodInput) -> WUnitMappings {
    WUnitMappings(mappings_from_food(&food))
}

/// All unit mappings for a product: stored rows (verbatim), food-derived edges,
/// and the synthesized `1 each = $price` edge. The TS
/// `getAllUnitMappingsFromProduct` is a thin wrapper over this; the costing
/// engine consumes the same synthesis internally.
#[wasm_bindgen]
pub fn product_unit_mappings(product: WProductInput) -> WUnitMappings {
    WUnitMappings(product_mappings(&product))
}

// ---------------------------------------------------------------------------
// Tests — including the ProMix fdc 576208 bare-count regression suite, ported
// from unit-mapping-utils.unit.test.ts (which now re-verifies the same cases
// through the TS wrapper).
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use ingredient::unit::{Measure, MeasureKind, convert_measure_with_graph, make_graph};
    use rstest::rstest;

    fn promix_product(household_text: &str) -> WProductInput {
        WProductInput {
            id: "prod-promix".to_string(),
            price: Some(39.99),
            unit_mappings: vec![],
            food: Some(WFoodInput {
                fdc_id: 576208,
                portions: vec![],
                serving: Some(WFoodServing {
                    serving_size: Some(44.3),
                    serving_size_unit: Some("g".to_string()),
                    household_serving_fulltext: Some(household_text.to_string()),
                }),
                nutrients_per_100: vec![],
            }),
        }
    }

    fn convert(mappings: &[WUnitMapping], from: Measure, kind: MeasureKind) -> Option<Measure> {
        let pairs: Vec<_> = mappings.iter().map(WUnitMapping::to_pair).collect();
        let graph = make_graph(&pairs);
        convert_measure_with_graph(&from, kind, &graph)
    }

    #[test]
    fn bare_count_serving_emits_household_word_not_whole() {
        let mappings = product_mappings(&promix_product("2 SCOOPS"));
        let serving = mappings
            .iter()
            .find(|m| m.source.as_deref() == Some("USDA FDC serving"))
            .expect("serving mapping present");

        assert_eq!(serving.a.value, 44.3);
        assert_eq!(serving.a.unit, "g");
        assert_eq!(serving.b.value, 2.0);
        assert_eq!(serving.b.unit, "scoop"); // normalized, NOT "whole"
    }

    #[test]
    fn grams_have_no_path_to_money() {
        // Pre-guard this resolved to ~$90.27 (50 g ÷ 22.15 g/serving × $39.99/each).
        let mappings = product_mappings(&promix_product("2 SCOOPS"));
        let result = convert(&mappings, Measure::new("g", 50.0), MeasureKind::Money);
        assert!(result.is_none());
    }

    #[test]
    fn scoops_still_convert_to_grams() {
        let mappings = product_mappings(&promix_product("2 SCOOPS"));
        let grams = convert(&mappings, Measure::new("scoop", 1.0), MeasureKind::Weight)
            .expect("scoop→g path");
        assert!((grams.value() - 22.15).abs() < 0.5);
    }

    #[test]
    fn bare_count_recipe_amounts_still_price_via_each() {
        // "2 whole" (e.g. 2 bags) → 2 × $39.99: each≡whole survives; only the
        // serving-metadata side is barred from emitting bare counts.
        let mappings = product_mappings(&promix_product("2 SCOOPS"));
        let price = convert(&mappings, Measure::new("whole", 2.0), MeasureKind::Money)
            .expect("whole→money path");
        assert!((price.value() - 79.98).abs() < 0.005);
    }

    /// The empty-household-word branch: a bare count with no trailing noun ("2")
    /// parses to `2 ⟨whole⟩` with an empty name, so the relabel has no household
    /// word to use and falls back to the generic "serving" unit (never the
    /// price-bearing "whole").
    #[test]
    fn bare_count_serving_with_no_word_falls_back_to_serving() {
        let mappings = product_mappings(&promix_product("2"));
        let serving = mappings
            .iter()
            .find(|m| m.source.as_deref() == Some("USDA FDC serving"))
            .expect("serving mapping present");
        assert_eq!(serving.b.unit, "serving");
    }

    #[test]
    fn household_text_with_real_unit_is_unchanged() {
        let mappings = product_mappings(&promix_product("0.5 cup"));
        let serving = mappings
            .iter()
            .find(|m| m.source.as_deref() == Some("USDA FDC serving"))
            .expect("serving mapping present");
        assert_eq!(serving.b.unit, "cup");
        assert_eq!(serving.b.value, 0.5);
    }

    #[rstest]
    #[case("GM", Some("g"))]
    #[case("GRM", Some("g"))]
    #[case("MC", Some("ml"))]
    #[case("MLT", Some("ml"))]
    #[case("g", Some("g"))]
    #[case("ml", Some("ml"))]
    #[case("MG", Some("MG"))]
    #[case("IU", Some("IU"))]
    #[case("OZ", None)] // outside the enum → mapping skipped
    fn serving_size_unit_normalization(#[case] input: &str, #[case] expected: Option<&str>) {
        assert_eq!(normalize_serving_size_unit(input), expected);
    }

    #[test]
    fn unknown_serving_unit_skips_the_mapping() {
        let mut product = promix_product("2 SCOOPS");
        if let Some(food) = product.food.as_mut() {
            if let Some(serving) = food.serving.as_mut() {
                serving.serving_size_unit = Some("OZ".to_string());
            }
        }
        let mappings = product_mappings(&product);
        assert!(
            !mappings
                .iter()
                .any(|m| m.source.as_deref() == Some("USDA FDC serving")),
            "unknown serving unit must skip the serving mapping"
        );
    }

    #[test]
    fn portion_and_nutrition_and_price_edges() {
        let product = WProductInput {
            id: "prod-1".to_string(),
            price: Some(3.5),
            unit_mappings: vec![],
            food: Some(WFoodInput {
                fdc_id: 1234,
                portions: vec![WFoodPortion {
                    amount: 1.0,
                    modifier: Some("cup".to_string()),
                    gram_weight: 120.0,
                }],
                serving: None,
                nutrients_per_100: vec![
                    WNutrientPer100 {
                        unit: "g protein".to_string(),
                        amount: 15.0,
                    },
                    // zero amounts are dropped
                    WNutrientPer100 {
                        unit: "mg sodium".to_string(),
                        amount: 0.0,
                    },
                ],
            }),
        };
        let mappings = product_mappings(&product);

        assert_eq!(mappings.len(), 3);
        // portion: 1 cup = 120 g
        assert_eq!(mappings[0].a.unit, "cup");
        assert_eq!(mappings[0].b.value, 120.0);
        assert_eq!(
            mappings[0].source_metadata,
            Some(WSourceMetadata::Food { fdc_id: 1234 })
        );
        // nutrition: 100 g = 15 g protein
        assert_eq!(mappings[1].b.unit, "g protein");
        // price: 1 each = $3.50
        assert_eq!(mappings[2].a.unit, "each");
        assert_eq!(mappings[2].b.value, 3.5);
        assert_eq!(
            mappings[2].source_metadata,
            Some(WSourceMetadata::Product {
                product_id: "prod-1".to_string()
            })
        );
    }

    #[test]
    fn stored_mappings_pass_through_with_their_metadata() {
        let stored = WUnitMapping {
            a: amount(4.0, "lb"),
            b: amount(5.0, "dollar"),
            source: Some("costco".to_string()),
            source_metadata: Some(WSourceMetadata::Manual),
        };
        let product = WProductInput {
            id: "prod-1".to_string(),
            price: None,
            unit_mappings: vec![stored],
            food: None,
        };
        let mappings = product_mappings(&product);
        assert_eq!(mappings.len(), 1);
        assert_eq!(mappings[0].source.as_deref(), Some("costco"));
        assert_eq!(mappings[0].source_metadata, Some(WSourceMetadata::Manual));
    }

    #[test]
    fn source_metadata_serde_matches_the_ts_contract() {
        // The zod discriminated union: {type:"product",productId} | {type:"food",fdcId} | {type:"manual"}
        assert_eq!(
            serde_json::to_value(WSourceMetadata::Product {
                product_id: "p1".to_string()
            })
            .unwrap(),
            serde_json::json!({"type": "product", "productId": "p1"})
        );
        assert_eq!(
            serde_json::to_value(WSourceMetadata::Food { fdc_id: 42 }).unwrap(),
            serde_json::json!({"type": "food", "fdcId": 42})
        );
        assert_eq!(
            serde_json::to_value(WSourceMetadata::Manual).unwrap(),
            serde_json::json!({"type": "manual"})
        );
    }
}
