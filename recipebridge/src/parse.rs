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
/// Wraps the parser's `singular` so cubby and ingredient-parser agree on the
/// rule (it guards "glass" and handles real yield units).
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
