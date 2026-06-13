//! Boundary types for the recipe-costing engine.
//!
//! Output rows serialize to the shape the zod `rowDiagnostic` contract expects
//! (packages/schemas/src/recipe.ts) — camelCase renames are per-field, inputs
//! stay snake_case per crate convention. The TS wrapper normalizes the
//! undefined/null distinction (serde-wasm-bindgen emits `undefined` for None).

use serde::{Deserialize, Serialize};
use tsify_next::Tsify;

use super::consumption::PlanTrio;
use crate::{WAmount, WConversionStep, WIngredientUsage, WProductInput};

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

/// Row kind (the zod `kind: "ingredient" | "recipe"`).
#[derive(Tsify, Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum WRowKind {
    Ingredient,
    Recipe,
}

/// One flattened section-ingredient row, as the engine consumes it.
#[derive(Tsify, Serialize, Deserialize)]
pub struct WCostingRow {
    /// The section-ingredient row id (diagnostics key).
    pub id: String,
    pub kind: WRowKind,
    /// Ingredient id or sub-recipe id, per `kind`.
    pub target_id: String,
    /// TS-resolved display name (the old `getIngredientName` output) — feeds
    /// the classifier and the missing-data labels.
    pub name: String,
    /// The row's written amounts, in source order. The engine resolves each
    /// costing measure from these, PREFERRING an amount already of that measure's
    /// kind — so a stated weight ("8½ oz") drives grams directly (via the unit
    /// engine's mass identity) instead of a volume that needs a density mapping.
    /// Empty when the line carries no amount ("to taste").
    #[serde(default)]
    pub amounts: Vec<WAmount>,
    #[serde(default)]
    #[tsify(type = "string | null")]
    pub modifier: Option<String>,
    #[serde(default)]
    #[tsify(type = "string | null")]
    pub raw_line: Option<String>,
    /// The enclosing section's name — some usage classifications are
    /// section-level ("For the marinade", "Brine"), not line-level.
    #[serde(default)]
    #[tsify(type = "string | null")]
    pub section_name: Option<String>,
}

/// One recipe in the costing closure (a root or a transitively-reached sub).
#[derive(Tsify, Serialize, Deserialize)]
pub struct WCostingRecipe {
    pub id: String,
    /// Structured yield — required for this recipe to be costable as a
    /// sub-recipe of another.
    #[serde(default)]
    #[tsify(type = "WAmount | null")]
    pub recipe_yield: Option<WAmount>,
    pub rows: Vec<WCostingRow>,
}

/// An ingredient with its linked products (each serialized ONCE per call,
/// however many rows reference it).
#[derive(Tsify, Serialize, Deserialize)]
pub struct WCostingIngredient {
    pub id: String,
    pub products: Vec<WProductInput>,
}

/// One nutrient conversion target. TS stays the source of truth for the tier-1
/// list; `unit` is the target string ("g protein") — `"kcal"` is special-cased
/// to `MeasureKind::Calories` (Unit::KCal ≠ Unit::Other("kcal") in the graph).
#[derive(Tsify, Serialize, Deserialize)]
pub struct WNutrientTarget {
    /// USDA nutrient code ("203", "208", …) — keys the output entries.
    pub code: String,
    pub unit: String,
}

/// Everything one `cost_recipes` call needs: the recipe closure, the deduped
/// ingredient map, the nutrient targets, and the explain flag.
#[derive(Tsify, Serialize, Deserialize)]
#[tsify(from_wasm_abi)]
pub struct WCostingInput {
    /// Recipes to produce results for (each must appear in `recipes`).
    pub root_ids: Vec<String>,
    /// The full closure: roots plus every transitively-reachable sub-recipe.
    pub recipes: Vec<WCostingRecipe>,
    pub ingredients: Vec<WCostingIngredient>,
    /// All tier-1 targets including kcal, in TIER1_NUTRIENTS order (the order
    /// drives nutrient output + sub-recipe yield-mapping construction).
    pub nutrient_targets: Vec<WNutrientTarget>,
    /// Attach unit-graph conversion paths to root rows (the explain surfaces).
    pub explain: bool,
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

/// One resolved measure: the zod `measureDiagnostic` union,
/// `{ok:true,value,unit} | {ok:false,error}`.
#[derive(Tsify, Serialize, Deserialize, Clone, Debug)]
pub struct WMeasureOk {
    #[tsify(type = "true")]
    pub ok: bool,
    pub value: f64,
    pub unit: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[tsify(optional)]
    pub upper_value: Option<f64>,
}

#[derive(Tsify, Serialize, Deserialize, Clone, Debug)]
pub struct WMeasureErr {
    #[tsify(type = "false")]
    pub ok: bool,
    pub error: String,
}

#[derive(Tsify, Serialize, Deserialize, Clone, Debug)]
#[serde(untagged)]
pub enum WMeasureResult {
    Ok(WMeasureOk),
    Err(WMeasureErr),
}

impl WMeasureResult {
    pub fn err(error: impl Into<String>) -> Self {
        Self::Err(WMeasureErr {
            ok: false,
            error: error.into(),
        })
    }
}

/// One converted nutrient (`code` is the USDA nutrient code from the target).
#[derive(Tsify, Serialize, Deserialize, Clone, Debug)]
pub struct WNutrientAmount {
    pub code: String,
    pub value: f64,
}

/// All of a row's resolved nutrients, or the error every code shares. The TS
/// wrapper derives the zod `nutrientDiagnostic` summary ({kcal, nutrientCount})
/// from the entries.
#[derive(Tsify, Serialize, Deserialize, Clone, Debug)]
pub struct WNutrientsOk {
    #[tsify(type = "true")]
    pub ok: bool,
    pub entries: Vec<WNutrientAmount>,
}

#[derive(Tsify, Serialize, Deserialize, Clone, Debug)]
pub struct WNutrientsErr {
    #[tsify(type = "false")]
    pub ok: bool,
    pub error: String,
}

#[derive(Tsify, Serialize, Deserialize, Clone, Debug)]
#[serde(untagged)]
pub enum WNutrientsResult {
    Ok(WNutrientsOk),
    Err(WNutrientsErr),
}

impl WNutrientsResult {
    pub fn err(error: impl Into<String>) -> Self {
        Self::Err(WNutrientsErr {
            ok: false,
            error: error.into(),
        })
    }
}

/// Unit-graph routes per measure (explain mode only; None = no path).
#[derive(Tsify, Serialize, Deserialize, Debug)]
pub struct WRowPaths {
    #[tsify(type = "WConversionStep[] | null")]
    pub money: Option<Vec<WConversionStep>>,
    #[tsify(type = "WConversionStep[] | null")]
    pub weight: Option<Vec<WConversionStep>>,
    #[tsify(type = "WConversionStep[] | null")]
    pub calories: Option<Vec<WConversionStep>>,
}

/// Per-row costing trace + resolved measures, in input order. The diagnostic
/// fields serialize to the zod `rowDiagnostic` shape; `own_gram`/`estimated`
/// are the extra per-row data the table view consumes (display trio = the
/// resolved trio; baker % uses the pre-estimate own gram).
#[derive(Tsify, Serialize, Deserialize, Debug)]
pub struct WRowResult {
    pub id: String,
    pub name: String,
    #[serde(rename = "sectionName")]
    #[tsify(type = "string | null")]
    pub section_name: Option<String>,
    pub kind: WRowKind,
    pub usage: WIngredientUsage,
    pub measured: bool,
    pub plan: PlanTrio,
    /// Basis weight (g) deferred rows estimated from; None for pass-1 rows.
    #[serde(rename = "basisGrams")]
    #[tsify(type = "number | null")]
    pub basis_grams: Option<f64>,
    pub price: WMeasureResult,
    pub gram: WMeasureResult,
    pub nutrients: WNutrientsResult,
    /// The row's own-amount gram weight, pre-estimate — baker's percentage
    /// parity with the old `createIngredientData` trio. None when the row has
    /// no own amount or no weight path.
    #[tsify(type = "number | null")]
    pub own_gram: Option<f64>,
    /// True when any measure was adjusted away from the written amount
    /// (the "est."/"absorbed" markers).
    pub estimated: bool,
    /// Whether the engine classified this row as a flour (the baker's-%
    /// base) — computed from the row name, not caller-provided.
    pub is_flour: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[tsify(optional)]
    pub paths: Option<WRowPaths>,
}

/// Baker's percentage per row: own grams ÷ total flour grams × 100. None when
/// the row has no gram weight or no flour was detected.
#[derive(Tsify, Serialize, Deserialize, Debug)]
pub struct WBakerPct {
    pub row_id: String,
    #[tsify(type = "number | null")]
    pub pct: Option<f64>,
}

/// Names of rows whose measure couldn't resolve, per measure (display names,
/// in resolution order — pass-1 rows then pass-2 rows).
#[derive(Tsify, Serialize, Deserialize, Debug, PartialEq)]
pub struct WMissingByType {
    pub price: Vec<String>,
    pub weight: Vec<String>,
    pub nutrients: Vec<String>,
}

/// One recipe's full costing result.
#[derive(Tsify, Serialize, Deserialize, Debug)]
pub struct WRecipeCosting {
    pub recipe_id: String,
    pub price: f64,
    pub weight: f64,
    /// Summed nutrients, first-appearance order.
    pub nutrients: Vec<WNutrientAmount>,
    pub total_ingredients: u32,
    pub missing_by_type: WMissingByType,
    /// Per-row trace + resolved measures, in input order.
    pub rows: Vec<WRowResult>,
    pub baker_percentages: Vec<WBakerPct>,
}

/// The `cost_recipes` result: one entry per `root_ids` element, in order.
#[derive(Tsify, Serialize, Deserialize, Debug)]
#[tsify(into_wasm_abi)]
pub struct WCostingResult {
    pub recipes: Vec<WRecipeCosting>,
}
