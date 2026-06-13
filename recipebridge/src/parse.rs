//! Parsing + formatting exports: ingredient lines, rich instruction text,
//! scraped recipes, and freeform yields.

use ingredient::{
    from_str as parse_ingredient_str,
    ingredient::Ingredient,
    rich_text::{Chunk, RichParser},
    usage::IngredientUsage,
};
use recipe_scraper::{RecipeSection, RecipeYield, ScrapedRecipe};
use serde::{Deserialize, Serialize};
use tsify_next::Tsify;
use wasm_bindgen::prelude::*;

use crate::WAmount;

/// The role an ingredient line plays in a recipe (mirrors `IngredientUsage`).
/// The exhaustive `From` match below is the compile-time drift check: adding a
/// variant upstream without mirroring it here fails the build.
#[derive(Tsify, Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[tsify(into_wasm_abi)]
#[serde(rename_all = "snake_case")]
pub enum WIngredientUsage {
    Normal,
    FryingMedium,
    PanGrease,
    Seasoning,
    Dredging,
    Garnish,
    Marinade,
}

impl From<IngredientUsage> for WIngredientUsage {
    fn from(u: IngredientUsage) -> Self {
        match u {
            IngredientUsage::Normal => Self::Normal,
            IngredientUsage::FryingMedium => Self::FryingMedium,
            IngredientUsage::PanGrease => Self::PanGrease,
            IngredientUsage::Seasoning => Self::Seasoning,
            IngredientUsage::Dredging => Self::Dredging,
            IngredientUsage::Garnish => Self::Garnish,
            IngredientUsage::Marinade => Self::Marinade,
        }
    }
}

/// A parsed ingredient (mirrors `Ingredient`).
#[derive(Tsify, Serialize, Deserialize)]
#[tsify(into_wasm_abi)]
pub struct WIngredient {
    pub name: String,
    pub amounts: Vec<WAmount>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub modifier: Option<String>,
    /// The role the line declares ("oil, for frying" → `frying_medium`).
    pub usage: WIngredientUsage,
}

impl From<Ingredient> for WIngredient {
    fn from(i: Ingredient) -> Self {
        Self {
            name: i.name,
            amounts: i.amounts.iter().map(WAmount::from).collect(),
            modifier: i.modifier,
            usage: i.usage.into(),
        }
    }
}

/// Structured yield, e.g. `{ value: 12, unit: "pancakes" }`.
#[derive(Tsify, Serialize, Deserialize)]
pub struct WRecipeYield {
    pub value: f64,
    pub unit: String,
}

impl From<RecipeYield> for WRecipeYield {
    fn from(y: RecipeYield) -> Self {
        Self {
            value: y.value,
            unit: y.unit,
        }
    }
}

/// Result of parsing a freeform yield string into structured yield + servings.
#[derive(Tsify, Serialize, Deserialize)]
#[tsify(into_wasm_abi)]
pub struct WYieldResult {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recipe_yield: Option<WRecipeYield>,
    /// Servings as integer (extracted from yield if unit is "serving(s)").
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub servings: Option<u32>,
}

/// A recipe component with raw ingredient/instruction lines (mirrors `RecipeSection`).
#[derive(Tsify, Serialize, Deserialize)]
pub struct WRecipeSection {
    /// Component label (e.g., "For the sauce"); absent for the main/only section.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub ingredients: Vec<String>,
    pub instructions: Vec<String>,
}

impl From<RecipeSection> for WRecipeSection {
    fn from(s: RecipeSection) -> Self {
        Self {
            name: s.name,
            ingredients: s.ingredients,
            instructions: s.instructions,
        }
    }
}

/// A scraped recipe (the cubby-facing subset of `ScrapedRecipe`); the TS side
/// converts it to the shared `ImportRecipe` carrier.
#[derive(Tsify, Serialize, Deserialize)]
#[tsify(into_wasm_abi)]
pub struct WScrapedRecipe {
    /// Recipe components; most recipes have a single unnamed section.
    pub sections: Vec<WRecipeSection>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image: Option<String>,
    /// Headnote / intro blurb (schema.org `description`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// Parsed yield (e.g., `{ value: 12, unit: "pancakes" }`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recipe_yield: Option<WRecipeYield>,
    /// Servings as integer (extracted from yield if unit is "serving(s)").
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub servings: Option<u32>,
}

impl From<ScrapedRecipe> for WScrapedRecipe {
    fn from(r: ScrapedRecipe) -> Self {
        Self {
            sections: r.sections.into_iter().map(WRecipeSection::from).collect(),
            name: Some(r.name),
            url: Some(r.url),
            image: r.image,
            description: r.description,
            recipe_yield: r.recipe_yield.map(WRecipeYield::from),
            servings: r.servings,
        }
    }
}

/// One span of measurement-aware instruction text (mirrors `Chunk`).
#[derive(Tsify, Serialize, Deserialize)]
#[serde(tag = "kind", content = "value")]
pub enum RichItem {
    Text(String),
    Ing(String),
    Measure(Vec<WAmount>),
}

impl From<Chunk> for RichItem {
    fn from(c: Chunk) -> Self {
        match c {
            Chunk::Text(t) => RichItem::Text(t),
            Chunk::Ing(i) => RichItem::Ing(i),
            Chunk::Measure(ms) => RichItem::Measure(ms.iter().map(WAmount::from).collect()),
        }
    }
}

/// `RichItem[]` (`transparent` → `type RichItems = RichItem[]`).
#[derive(Tsify, Serialize, Deserialize)]
#[tsify(into_wasm_abi)]
#[serde(transparent)]
pub struct RichItems(pub Vec<RichItem>);

#[wasm_bindgen]
pub fn parse_ingredient(input: &str) -> WIngredient {
    parse_ingredient_str(input).into()
}

#[wasm_bindgen]
pub fn format_amount(amount: WAmount) -> String {
    amount.to_measure().to_string()
}

/// Singularize a unit for display labels ("churros" → "churro", "cups" → "cup").
/// Wraps the parser's `singular` so cubby and ingredient-parser agree on the rule,
/// including the `-es` guard ("glasses" → "glass", not "glasse"). It expects a
/// plural; an already-singular word is out of contract (e.g. "glass" → "glas").
/// See `singularize_unit_table` in the tests for the locked-in cases.
#[wasm_bindgen]
pub fn singularize_unit(unit: String) -> String {
    ingredient::unit::singular(&unit).to_string()
}

#[wasm_bindgen]
pub fn parse_scraped_recipe(body: &str, url: &str) -> Result<WScrapedRecipe, String> {
    recipe_scraper::scrape(body, url)
        .map_err(|e| format!("Failed to scrape: {e}"))
        .map(WScrapedRecipe::from)
}

/// Parse a freeform yield string ("Makes about 12 pancakes", "Serves 4") into a
/// structured `{ recipe_yield?, servings? }`, using the same parser the web
/// scraper uses for JSON-LD yields (so cookbook and web yields stay consistent).
#[wasm_bindgen]
pub fn parse_yield(input: &str) -> WYieldResult {
    let (recipe_yield, servings) = recipe_scraper::parse_yield_string(input);
    WYieldResult {
        recipe_yield: recipe_yield.map(WRecipeYield::from),
        servings,
    }
}

#[wasm_bindgen]
pub fn parse_rich_text(text: String, ingredient_names: Vec<String>) -> Result<RichItems, String> {
    RichParser::new(ingredient_names)
        .parse(&text)
        .map_err(|e| e.to_string())
        .map(|chunks| RichItems(chunks.into_iter().map(RichItem::from).collect()))
}

// ---------------------------------------------------------------------------
// Golden tests — drift tripwires for the ingredient / recipe-scraper crates
// (pinned by exact git rev in Cargo.toml). The parse_* fns are plain Rust under
// the #[wasm_bindgen] attribute, so they run natively under `cargo test`. The
// asserts pin the W-bridge serde shapes the TS side reads; a parser rev bump
// that changes classification, the snake_case rename, yield/singularization, or
// the rich-text chunk contract fails here instead of three layers downstream.
// ---------------------------------------------------------------------------
#[cfg(test)]
mod tests {
    use super::*;
    use rstest::rstest;

    /// One line per `WIngredientUsage` variant: the `IngredientUsage` drift
    /// tripwire. A parser change that drops or reclassifies a role would silently
    /// mis-cost (e.g. "oil, for frying" billed as a full ingredient) — caught here.
    #[rstest]
    #[case("2 cups flour", WIngredientUsage::Normal)]
    #[case("oil, for frying", WIngredientUsage::FryingMedium)]
    #[case("butter, for the pan", WIngredientUsage::PanGrease)]
    #[case("salt, to taste", WIngredientUsage::Seasoning)]
    #[case("flour, for dredging", WIngredientUsage::Dredging)]
    #[case("parsley, for garnish", WIngredientUsage::Garnish)]
    #[case("soy sauce, for marinating", WIngredientUsage::Marinade)]
    fn usage_classification(#[case] line: &str, #[case] expected: WIngredientUsage) {
        assert_eq!(parse_ingredient(line).usage, expected);
    }

    /// The snake_case wire contract the TS side reads (`frying_medium`, not
    /// `FryingMedium`) — locks the serde rename against an accidental drop.
    #[test]
    fn usage_serde_is_snake_case() {
        assert_eq!(
            serde_json::to_value(WIngredientUsage::FryingMedium).unwrap(),
            serde_json::json!("frying_medium")
        );
        assert_eq!(
            serde_json::to_value(WIngredientUsage::Normal).unwrap(),
            serde_json::json!("normal")
        );
    }

    /// `parse_ingredient` golden over serde — confirms the full W-bridge shape
    /// (name, one `{value, unit}` amount, snake_case usage, modifier omitted when
    /// absent), mirroring `component_source_serde_matches_the_zod_contract`.
    #[test]
    fn parse_ingredient_golden_shape() {
        let parsed = parse_ingredient("2 1/2 cups flour");
        assert_eq!(parsed.name, "flour");
        assert_eq!(parsed.usage, WIngredientUsage::Normal);
        assert_eq!(
            serde_json::to_value(&parsed).unwrap(),
            serde_json::json!({
                "name": "flour",
                "amounts": [{ "unit": "cup", "value": 2.5 }],
                "usage": "normal",
            })
        );
    }

    /// `parse_yield` pins the cookbook/web yield-consistency contract: a count
    /// yield carries the generic `whole` unit and no servings; a "Serves N" line
    /// populates `servings`. (Both surface the same parser the web scraper uses.)
    #[rstest]
    #[case("Makes about 12 pancakes", 12.0, None)]
    #[case("Serves 4", 4.0, Some(4))]
    fn parse_yield_table(#[case] input: &str, #[case] value: f64, #[case] servings: Option<u32>) {
        let result = parse_yield(input);
        let y = result.recipe_yield.expect("recipe_yield present");
        assert_eq!(y.value, value);
        // The parser emits a generic count unit ("whole") for bare counts; the
        // display layer relabels using the trailing noun.
        assert_eq!(y.unit, "whole");
        assert_eq!(result.servings, servings);
    }

    /// `singularize_unit` for display labels. The `-es` guard is the real lock:
    /// "glasses" → "glass" (not "glasse"). Note the singularizer's contract is
    /// plural → singular; an already-singular "glass" is out of scope and returns
    /// the naive strip "glas", so it isn't asserted here.
    #[rstest]
    #[case("cups", "cup")]
    #[case("churros", "churro")]
    #[case("glasses", "glass")]
    fn singularize_unit_table(#[case] plural: &str, #[case] expected: &str) {
        assert_eq!(singularize_unit(plural.to_string()), expected);
    }

    /// `parse_rich_text` chunk sequence + the `{kind, value}` serde tag shape the
    /// richtext UI consumes: known ingredient names → `Ing`, an inline measure →
    /// `Measure`, the rest → `Text`.
    #[test]
    fn parse_rich_text_chunks_and_tag_shape() {
        let items = parse_rich_text(
            "heat the oil and add 2 cups water".to_string(),
            vec!["oil".to_string(), "water".to_string()],
        )
        .expect("rich text parses");

        let kinds: Vec<&str> = items
            .0
            .iter()
            .map(|c| match c {
                RichItem::Text(_) => "Text",
                RichItem::Ing(_) => "Ing",
                RichItem::Measure(_) => "Measure",
            })
            .collect();
        assert_eq!(kinds, ["Text", "Ing", "Text", "Measure", "Text", "Ing"]);

        assert_eq!(
            serde_json::to_value(&items).unwrap(),
            serde_json::json!([
                { "kind": "Text", "value": "heat the " },
                { "kind": "Ing", "value": "oil" },
                { "kind": "Text", "value": " and add " },
                { "kind": "Measure", "value": [{ "unit": "cup", "value": 2.0 }] },
                { "kind": "Text", "value": " " },
                { "kind": "Ing", "value": "water" },
            ])
        );
    }
}
