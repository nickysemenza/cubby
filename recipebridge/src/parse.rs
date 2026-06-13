//! Parsing + formatting exports: ingredient lines, rich instruction text,
//! scraped recipes, and freeform yields.

use ingredient::{
    decompose as decompose_str, from_str as parse_ingredient_str,
    ingredient::Ingredient,
    rich_text::{Chunk, RichParser},
    usage::IngredientUsage,
    Decomposition, Field,
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

/// Which output field a decomposition segment became (mirrors `Field`). Renders
/// as the TS string union `"amount" | "name" | "modifier"`, matching the keys of
/// the `INGREDIENT_PART_COLOR` map on the TS side.
#[derive(Tsify, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WField {
    Amount,
    Name,
    Modifier,
}

impl From<Field> for WField {
    fn from(f: Field) -> Self {
        match f {
            Field::Amount => WField::Amount,
            Field::Name => WField::Name,
            Field::Modifier => WField::Modifier,
        }
    }
}

/// One contiguous chunk of the decomposed line: either a labeled field span or
/// unlabeled gap text. The segments concatenate back to the whole source, so JS
/// renders them in order with no byte-offset math (the Rust spans are UTF-8 byte
/// ranges, which don't map to JS UTF-16 indices).
#[derive(Tsify, Serialize, Deserialize)]
pub struct WSegment {
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub field: Option<WField>,
}

/// How the grammar carved a line into fields (mirrors `Decomposition`), as an
/// ordered list of segments covering the whole source. `segments` carries no
/// labeled entries when a whole-line recognizer or the name-only fallback
/// produced the result (then it's a single unlabeled segment = the whole line).
#[derive(Tsify, Serialize, Deserialize)]
#[tsify(into_wasm_abi)]
pub struct WDecomposition {
    pub source: String,
    pub segments: Vec<WSegment>,
}

impl From<Decomposition> for WDecomposition {
    fn from(d: Decomposition) -> Self {
        // Walk the sorted, non-overlapping spans, emitting any gap text before
        // each labeled span, then the span itself, then the trailing gap.
        let mut segments = Vec::new();
        let mut prev_end = 0usize;
        for span in &d.spans {
            if span.range.start > prev_end {
                segments.push(WSegment {
                    text: d.source[prev_end..span.range.start].to_string(),
                    field: None,
                });
            }
            segments.push(WSegment {
                text: span.text.clone(),
                field: Some(span.field.into()),
            });
            prev_end = span.range.end;
        }
        if prev_end < d.source.len() {
            segments.push(WSegment {
                text: d.source[prev_end..].to_string(),
                field: None,
            });
        }
        WDecomposition {
            source: d.source,
            segments,
        }
    }
}

#[wasm_bindgen]
pub fn parse_ingredient(input: &str) -> WIngredient {
    parse_ingredient_str(input).into()
}

/// Decompose a line into ordered `{text, field?}` segments showing how the
/// grammar carved it into amount / name / modifier spans. `source` is the
/// *normalized* line the spans index into, not the verbatim raw input.
#[wasm_bindgen]
pub fn decompose_ingredient(input: &str) -> WDecomposition {
    decompose_str(input).into()
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

    /// `WDecomposition::from` invariant: the segments always concatenate back to
    /// the whole `source` (no characters dropped or duplicated). This is the
    /// contract the TS renderer relies on to draw the carve with no offset math.
    /// Built directly from a `Decomposition` so the gap-walking is exercised
    /// without depending on a specific parser carving.
    #[test]
    fn decomposition_segments_cover_source() {
        use ingredient::FieldSpan;
        // "AA NN, MM" — a gap (space) before NN, the ", " gap before MM.
        let d = Decomposition {
            source: "AA NN, MM".to_string(),
            spans: vec![
                FieldSpan {
                    field: Field::Amount,
                    range: 0..2,
                    text: "AA".to_string(),
                },
                FieldSpan {
                    field: Field::Name,
                    range: 3..5,
                    text: "NN".to_string(),
                },
                FieldSpan {
                    field: Field::Modifier,
                    range: 7..9,
                    text: "MM".to_string(),
                },
            ],
        };
        let w = WDecomposition::from(d);
        // Segments concatenate back to the source verbatim.
        let joined: String = w.segments.iter().map(|s| s.text.as_str()).collect();
        assert_eq!(joined, "AA NN, MM");
        // Labeled fields appear in input order; gaps are unlabeled.
        let labeled: Vec<(&str, bool)> = w
            .segments
            .iter()
            .map(|s| (s.text.as_str(), s.field.is_some()))
            .collect();
        assert_eq!(
            labeled,
            [
                ("AA", true),
                (" ", false),
                ("NN", true),
                (", ", false),
                ("MM", true),
            ]
        );
    }

    /// Empty-spans case (whole-line recognizer / name-only fallback): a single
    /// unlabeled segment equal to the whole source, so the TS side renders plain
    /// text with no special-casing.
    #[test]
    fn decomposition_empty_spans_is_one_plain_segment() {
        let w = WDecomposition::from(Decomposition {
            source: "whole line".to_string(),
            spans: vec![],
        });
        assert_eq!(w.segments.len(), 1);
        assert_eq!(w.segments[0].text, "whole line");
        assert!(w.segments[0].field.is_none());
    }

    /// `decompose_ingredient` over a real parse: the carve of a standard line
    /// covers the source and labels amount/name spans. The `"lowercase"` serde
    /// rename (the TS string union) is pinned alongside.
    #[test]
    fn decompose_ingredient_real_parse() {
        let w = decompose_ingredient("2 cups flour");
        let joined: String = w.segments.iter().map(|s| s.text.as_str()).collect();
        assert_eq!(joined, w.source);
        let fields: Vec<serde_json::Value> = w
            .segments
            .iter()
            .filter_map(|s| s.field.as_ref())
            .map(|f| serde_json::to_value(f).unwrap())
            .collect();
        assert_eq!(
            fields,
            [serde_json::json!("amount"), serde_json::json!("name")]
        );
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
