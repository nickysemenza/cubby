//! Parity suite for the costing engine — the `calculateTotals` cases from
//! apps/web/src/lib/recipe-costing.unit.test.ts, expected values preserved.
//! The TS suite re-verifies the same numbers through the wasm boundary; this
//! file is the native-target net that runs in CI without a wasm runtime.

use recipebridge::{
    cost_recipes_impl, ComponentSource, WAmount, WCostingIngredient, WCostingInput,
    WCostingRecipe, WCostingRow, WMeasureResult, WNutrientTarget, WNutrientsResult,
    WProductInput, WRecipeCosting, WRowKind, WSourceMetadata, WSourcedUnitMapping,
};

// ─── Fixture builders (mirror the TS test builders) ─────────────────────────

fn amount(value: f64, unit: &str) -> WAmount {
    WAmount {
        unit: unit.to_string(),
        value,
        upper_value: None,
    }
}

fn mapping(a: (f64, &str), b: (f64, &str)) -> WSourcedUnitMapping {
    WSourcedUnitMapping {
        a: amount(a.0, a.1),
        b: amount(b.0, b.1),
        source: Some("test".to_string()),
        source_metadata: WSourceMetadata::Manual,
    }
}

/// An ingredient backed by one product carrying `mappings` (no food/price —
/// the TS tests' nutrient edges are stored mappings too).
fn ingredient(id: &str, mappings: Vec<WSourcedUnitMapping>) -> WCostingIngredient {
    WCostingIngredient {
        id: id.to_string(),
        products: vec![WProductInput {
            id: format!("prod-{id}"),
            price: None,
            unit_mappings: mappings,
            food: None,
        }],
    }
}

/// An ingredient with no product at all (forces missing price/weight/nutrients).
fn empty_ingredient(id: &str) -> WCostingIngredient {
    WCostingIngredient {
        id: id.to_string(),
        products: vec![],
    }
}

fn row(
    id: &str,
    name: &str,
    amt: Option<(f64, &str)>,
    modifier: Option<&str>,
    section: Option<&str>,
) -> WCostingRow {
    WCostingRow {
        id: id.to_string(),
        kind: WRowKind::Ingredient,
        target_id: id.to_string(),
        name: name.to_string(),
        amount: amt.map(|(v, u)| amount(v, u)),
        modifier: modifier.map(String::from),
        raw_line: None,
        section_name: section.map(String::from),
        is_flour: false,
    }
}

fn sub_recipe_row(sub_id: &str, amt: (f64, &str)) -> WCostingRow {
    WCostingRow {
        id: format!("link-{sub_id}"),
        kind: WRowKind::Recipe,
        target_id: sub_id.to_string(),
        name: "sub-recipe".to_string(),
        amount: Some(amount(amt.0, amt.1)),
        modifier: None,
        raw_line: None,
        section_name: None,
        is_flour: false,
    }
}

fn targets() -> Vec<WNutrientTarget> {
    // The relevant TIER1 subset, kcal last like the TS yield-mapping order
    // doesn't require — order only drives output entry order.
    [("203", "g protein"), ("307", "mg sodium"), ("208", "kcal")]
        .map(|(code, unit)| WNutrientTarget {
            code: code.to_string(),
            unit: unit.to_string(),
        })
        .into_iter()
        .collect()
}

fn cost(
    rows: Vec<WCostingRow>,
    ingredients: Vec<WCostingIngredient>,
    sub_recipes: Vec<WCostingRecipe>,
) -> WRecipeCosting {
    cost_with(rows, ingredients, sub_recipes, false)
}

fn cost_with(
    rows: Vec<WCostingRow>,
    ingredients: Vec<WCostingIngredient>,
    sub_recipes: Vec<WCostingRecipe>,
    explain: bool,
) -> WRecipeCosting {
    let mut recipes = vec![WCostingRecipe {
        id: "root".to_string(),
        recipe_yield: None,
        rows,
    }];
    recipes.extend(sub_recipes);
    let input = WCostingInput {
        root_ids: vec!["root".to_string()],
        recipes,
        ingredients,
        nutrient_targets: targets(),
        explain,
    };
    cost_recipes_impl(&input)
        .expect("costing succeeds")
        .recipes
        .remove(0)
}

fn nutrient(r: &WRecipeCosting, code: &str) -> f64 {
    r.nutrients
        .iter()
        .find(|n| n.code == code)
        .map(|n| n.value)
        .unwrap_or(0.0)
}

fn assert_close(actual: f64, expected: f64, tol: f64, what: &str) {
    assert!(
        (actual - expected).abs() < tol,
        "{what}: expected ~{expected}, got {actual}"
    );
}

// ─── Shared ingredients (the TS describe-block fixtures) ────────────────────

/// chicken: 1 lb = 453.59 g; 1 lb = $5.99; 100 g = 20 g protein = 200 kcal
fn chicken() -> WCostingIngredient {
    ingredient(
        "ing1",
        vec![
            mapping((1.0, "pound"), (453.59, "gram")),
            mapping((1.0, "pound"), (5.99, "dollar")),
            mapping((100.0, "g"), (20.0, "g protein")),
            mapping((100.0, "g"), (200.0, "kcal")),
        ],
    )
}

/// flour: 1 cup = 100 g; 100 g = 364 kcal = 10 g protein; 1 cup = $1
fn flour_mappings() -> Vec<WSourcedUnitMapping> {
    vec![
        mapping((1.0, "cup"), (100.0, "gram")),
        mapping((100.0, "g"), (364.0, "kcal")),
        mapping((100.0, "g"), (10.0, "g protein")),
        mapping((1.0, "cup"), (1.0, "dollar")),
    ]
}

/// oil: 100 g = 884 kcal; 1000 g = $5
fn oil() -> WCostingIngredient {
    ingredient(
        "oil",
        vec![
            mapping((100.0, "g"), (884.0, "kcal")),
            mapping((1000.0, "g"), (5.0, "dollar")),
        ],
    )
}

fn flour_cup() -> WCostingRow {
    row("flour", "flour", Some((1.0, "cup")), None, None)
}

fn frying_oil() -> WCostingRow {
    row("oil", "neutral oil", None, Some("for frying"), None)
}

// ─── calculateTotals ─────────────────────────────────────────────────────────

#[test]
fn calculates_totals_with_all_data_available() {
    // rice: 1 cup = 200 g; 1 cup = $2.50; 100 g = 7 g protein = 130 kcal
    let rice = ingredient(
        "ing2",
        vec![
            mapping((1.0, "cup"), (200.0, "gram")),
            mapping((1.0, "cup"), (2.5, "dollar")),
            mapping((100.0, "g"), (7.0, "g protein")),
            mapping((100.0, "g"), (130.0, "kcal")),
        ],
    );
    let r = cost(
        vec![
            row("ing1", "chicken", Some((1.0, "pound")), None, None),
            row("ing2", "rice", Some((2.0, "cup")), None, None),
        ],
        vec![chicken(), rice],
        vec![],
    );

    assert_eq!(r.total_ingredients, 2);
    assert_close(r.price, 10.99, 0.005, "price"); // 5.99 + 5.00
    assert_close(r.weight, 854.0, 0.05, "weight"); // rounds: ~454 + 400
    assert!(r.missing_by_type.price.is_empty());
    assert!(r.missing_by_type.weight.is_empty());
    assert!(r.missing_by_type.nutrients.is_empty());
}

#[test]
fn handles_completely_missing_data() {
    let r = cost(
        vec![row(
            "ing1",
            "unknown ingredient",
            Some((1.0, "unknownunit")),
            None,
            None,
        )],
        vec![empty_ingredient("ing1")],
        vec![],
    );

    assert_eq!(r.total_ingredients, 1);
    assert_eq!(r.price, 0.0);
    assert_eq!(r.weight, 0.0);
    assert_eq!(nutrient(&r, "203"), 0.0);
    assert_eq!(nutrient(&r, "208"), 0.0);
    assert_eq!(r.missing_by_type.price, vec!["unknown ingredient"]);
    assert_eq!(r.missing_by_type.weight, vec!["unknown ingredient"]);
    assert_eq!(r.missing_by_type.nutrients, vec!["unknown ingredient"]);
}

#[test]
fn handles_partially_missing_data() {
    let r = cost(
        vec![
            row("ing1", "chicken", Some((1.0, "pound")), None, None),
            row("ing2", "unknown spice", Some((1.0, "teaspoon")), None, None),
        ],
        vec![chicken(), empty_ingredient("ing2")],
        vec![],
    );

    assert_eq!(r.total_ingredients, 2);
    assert_close(r.price, 5.99, 0.005, "price");
    assert_close(r.weight, 454.0, 0.05, "weight");
    assert_eq!(r.missing_by_type.price, vec!["unknown spice"]);
    assert_eq!(r.missing_by_type.weight, vec!["unknown spice"]);
    assert_eq!(r.missing_by_type.nutrients, vec!["unknown spice"]);
}

#[test]
fn handles_missing_only_specific_data_types() {
    let name = "ingredient with weight only";
    let weight_only = ingredient("ing1", vec![mapping((1.0, "cup"), (240.0, "gram"))]);
    let r = cost(
        vec![row("ing1", name, Some((1.0, "cup")), None, None)],
        vec![weight_only],
        vec![],
    );

    assert_eq!(r.price, 0.0);
    assert_eq!(r.weight, 240.0);
    assert_eq!(r.missing_by_type.price, vec![name]);
    assert!(r.missing_by_type.weight.is_empty());
    assert_eq!(r.missing_by_type.nutrients, vec![name]);
}

#[test]
fn handles_row_with_no_amounts() {
    let name = "problematic ingredient";
    let r = cost(
        vec![row("ing1", name, None, None, None)],
        vec![empty_ingredient("ing1")],
        vec![],
    );

    assert_eq!(r.price, 0.0);
    assert_eq!(r.weight, 0.0);
    assert_eq!(r.missing_by_type.price, vec![name]);
    assert_eq!(r.missing_by_type.weight, vec![name]);
    assert_eq!(r.missing_by_type.nutrients, vec![name]);
}

// ─── Sub-recipes ─────────────────────────────────────────────────────────────

#[test]
fn rolls_sub_recipe_totals_into_parent_scaled_by_yield() {
    let tomato = ingredient(
        "tomato",
        vec![
            mapping((1.0, "cup"), (100.0, "gram")),
            mapping((1.0, "cup"), (1.0, "dollar")),
            mapping((100.0, "g"), (10.0, "g protein")),
            mapping((100.0, "g"), (50.0, "kcal")),
        ],
    );
    let pasta = ingredient(
        "pasta",
        vec![
            mapping((1.0, "scoop"), (100.0, "gram")),
            mapping((1.0, "scoop"), (3.0, "dollar")),
            mapping((100.0, "g"), (5.0, "g protein")),
            mapping((100.0, "g"), (100.0, "kcal")),
        ],
    );
    // Sub-recipe "tomato sauce" yields 4 cups; uses 4 cups of tomato.
    // Its totals: $4, 400 g, 40 g protein, 200 kcal.
    let sauce = WCostingRecipe {
        id: "sauce".to_string(),
        recipe_yield: Some(amount(4.0, "cup")),
        rows: vec![row("tomato", "tomato", Some((4.0, "cup")), None, None)],
    };

    // Parent: 1 scoop pasta + 2 cups of the 4-cup sauce (= half).
    let r = cost(
        vec![
            row("pasta", "pasta", Some((1.0, "scoop")), None, None),
            sub_recipe_row("sauce", (2.0, "cup")),
        ],
        vec![tomato, pasta],
        vec![sauce],
    );

    assert_close(r.price, 5.0, 0.005, "price"); // pasta $3 + half of $4
    assert_close(r.weight, 300.0, 0.05, "weight"); // 100 + half of 400
    assert_close(nutrient(&r, "203"), 25.0, 0.05, "protein"); // 5 + 20
    assert_close(nutrient(&r, "208"), 200.0, 0.05, "kcal"); // 100 + 100
    assert!(r.missing_by_type.price.is_empty());
    assert!(r.missing_by_type.weight.is_empty());
    assert!(r.missing_by_type.nutrients.is_empty());
    assert_eq!(r.total_ingredients, 2);
}

#[test]
fn guards_against_cycles_without_hanging() {
    // A uses B, B uses A.
    let recipe_a = WCostingRecipe {
        id: "recA".to_string(),
        recipe_yield: Some(amount(1.0, "batch")),
        rows: vec![sub_recipe_row("recB", (1.0, "batch"))],
    };
    let recipe_b = WCostingRecipe {
        id: "recB".to_string(),
        recipe_yield: Some(amount(1.0, "batch")),
        rows: vec![sub_recipe_row("recA", (1.0, "batch"))],
    };
    let input = WCostingInput {
        root_ids: vec!["recA".to_string()],
        recipes: vec![recipe_a, recipe_b],
        ingredients: vec![],
        nutrient_targets: targets(),
        explain: false,
    };

    // Should terminate (visited-set cycle guard), not hang.
    let result = cost_recipes_impl(&input).expect("terminates");
    assert!(result.recipes[0].price.is_finite());
}

#[test]
fn flags_yield_less_sub_recipe_as_missing() {
    let sauce = WCostingRecipe {
        id: "sauce".to_string(),
        recipe_yield: None,
        rows: vec![row("tomato", "tomato", Some((1.0, "cup")), None, None)],
    };
    let r = cost(vec![sub_recipe_row("sauce", (2.0, "cup"))], vec![], vec![sauce]);

    assert_eq!(r.price, 0.0);
    assert_eq!(r.weight, 0.0);
    assert_eq!(r.missing_by_type.price, vec!["sub-recipe"]);
    assert_eq!(r.missing_by_type.weight, vec!["sub-recipe"]);
    assert_eq!(r.missing_by_type.nutrients, vec!["sub-recipe"]);
}

// ─── Consumption model (through the real classifier) ────────────────────────

#[test]
fn unmeasured_frying_oil_absorbed_estimate() {
    let r = cost(
        vec![flour_cup(), frying_oil()],
        vec![ingredient("flour", flour_mappings()), oil()],
        vec![],
    );

    // batter = 100 g flour; absorbed oil = 0.15 * 100 = 15 g
    assert_close(r.weight, 115.0, 0.5, "weight");
    // kcal: flour 364 + oil (15/100 * 884 = 132.6, graph-rounded)
    assert_close(nutrient(&r, "208"), 496.6, 0.5, "kcal");
    assert_close(nutrient(&r, "203"), 10.0, 0.5, "protein"); // flour only
    assert_close(r.price, 1.075, 0.05, "price"); // $1 + ~$0.075
    assert!(r.missing_by_type.price.is_empty());
    assert!(r.missing_by_type.weight.is_empty());
    assert!(r.missing_by_type.nutrients.is_empty());
    assert_eq!(r.total_ingredients, 2);
}

#[test]
fn control_without_frying_medium_is_unchanged() {
    let r = cost(
        vec![flour_cup()],
        vec![ingredient("flour", flour_mappings())],
        vec![],
    );
    assert_close(r.weight, 100.0, 0.5, "weight");
    assert_close(nutrient(&r, "208"), 364.0, 0.5, "kcal");
}

#[test]
fn measured_frying_oil_full_cost_absorbed_weight_excluded_from_basis() {
    // "100 g oil, for frying" — the amount is the pot, not consumption.
    let measured_oil = row("oil", "neutral oil", Some((100.0, "g")), Some("for frying"), None);
    let r = cost(
        vec![flour_cup(), measured_oil],
        vec![ingredient("flour", flour_mappings()), oil()],
        vec![],
    );

    // Weight: flour 100 + absorbed 15 — NOT 200; the pot never feeds the basis.
    assert_close(r.weight, 115.0, 0.5, "weight");
    // kcal: 364 + 132.6 — NOT 364 + 884.
    assert_close(nutrient(&r, "208"), 496.6, 0.5, "kcal");
    // Price: flour $1 + the FULL pot $0.50 — you bought it.
    assert_close(r.price, 1.5, 0.005, "price");
    assert!(r.missing_by_type.price.is_empty());
}

#[test]
fn frying_medium_with_no_mapping_fails_gracefully() {
    let r = cost(
        vec![flour_cup(), frying_oil()],
        vec![ingredient("flour", flour_mappings()), empty_ingredient("oil")],
        vec![],
    );

    assert_close(r.weight, 100.0, 0.5, "weight");
    assert_close(nutrient(&r, "208"), 364.0, 0.5, "kcal");
    assert!(r
        .missing_by_type
        .nutrients
        .contains(&"neutral oil".to_string()));
}

#[test]
fn estimate_only_recipe_has_no_basis() {
    let r = cost(vec![frying_oil()], vec![oil()], vec![]);

    assert_eq!(r.weight, 0.0);
    assert!(r.missing_by_type.price.contains(&"neutral oil".to_string()));
    assert!(r.missing_by_type.weight.contains(&"neutral oil".to_string()));
    assert!(r
        .missing_by_type
        .nutrients
        .contains(&"neutral oil".to_string()));
}

/// salt: 100 g = 38758 mg sodium; 100 g = $0.10
fn salt() -> WCostingIngredient {
    ingredient(
        "salt",
        vec![
            mapping((100.0, "g"), (38758.0, "mg sodium")),
            mapping((100.0, "g"), (0.1, "dollar")),
        ],
    )
}

#[test]
fn totals_are_order_independent() {
    let ings = || vec![ingredient("flour", flour_mappings()), oil(), salt()];
    let salt_to_taste = || row("salt", "salt", None, Some("to taste"), None);

    let forward = cost(
        vec![flour_cup(), frying_oil(), salt_to_taste()],
        ings(),
        vec![],
    );
    let reversed = cost(
        vec![salt_to_taste(), frying_oil(), flour_cup()],
        ings(),
        vec![],
    );

    assert_close(reversed.weight, forward.weight, 1e-5, "weight");
    assert_close(reversed.price, forward.price, 1e-5, "price");
    for n in &forward.nutrients {
        assert_close(nutrient(&reversed, &n.code), n.value, 1e-9, &n.code);
    }
    assert_eq!(forward.nutrients.len(), reversed.nutrients.len());
}

#[test]
fn seasoning_salt_to_taste_one_percent_of_basis() {
    let r = cost(
        vec![flour_cup(), row("salt", "salt", None, Some("to taste"), None)],
        vec![ingredient("flour", flour_mappings()), salt()],
        vec![],
    );

    // 1 g salt (0.01 × 100 g flour) → ~387.6 mg sodium, ~$0.001
    assert_close(r.weight, 101.0, 0.5, "weight");
    assert_close(nutrient(&r, "307"), 387.6, 0.5, "sodium");
    assert_close(r.price, 1.001, 0.005, "price");
    assert!(r.missing_by_type.nutrients.is_empty());
}

#[test]
fn measured_salt_is_normal_even_with_to_taste() {
    let r = cost(
        vec![
            flour_cup(),
            row("salt", "salt", Some((5.0, "g")), Some("to taste"), None),
        ],
        vec![ingredient("flour", flour_mappings()), salt()],
        vec![],
    );

    assert_close(r.weight, 105.0, 0.5, "weight");
    assert_close(nutrient(&r, "307"), 1937.9, 0.5, "sodium");
}

#[test]
fn pan_grease_butter_flat_ten_grams() {
    // butter: 100 g = 717 kcal; 100 g = $1
    let butter = ingredient(
        "butter",
        vec![
            mapping((100.0, "g"), (717.0, "kcal")),
            mapping((100.0, "g"), (1.0, "dollar")),
        ],
    );
    let r = cost(
        vec![
            flour_cup(),
            row("butter", "butter", None, Some("for the pan"), None),
        ],
        vec![ingredient("flour", flour_mappings()), butter],
        vec![],
    );

    assert_close(r.weight, 110.0, 0.5, "weight");
    assert_close(nutrient(&r, "208"), 364.0 + 71.7, 0.5, "kcal");
    assert_close(r.price, 1.1, 0.005, "price");
}

#[test]
fn garnish_parsley_flat_five_grams_unmapped_measures_missing() {
    // parsley: 100 g = 36 kcal (no price mapping on purpose)
    let parsley = ingredient("parsley", vec![mapping((100.0, "g"), (36.0, "kcal"))]);
    let r = cost(
        vec![
            flour_cup(),
            row("parsley", "parsley", None, Some("for garnish"), None),
        ],
        vec![ingredient("flour", flour_mappings()), parsley],
        vec![],
    );

    assert_close(r.weight, 105.0, 0.5, "weight");
    assert_close(nutrient(&r, "208"), 364.0 + 1.8, 0.5, "kcal");
    assert_eq!(r.missing_by_type.price, vec!["parsley"]);
}

#[test]
fn unmeasured_dredging_flour_five_percent_of_basis() {
    let r = cost(
        vec![
            flour_cup(),
            row("flour2", "flour", None, Some("for dusting"), None),
        ],
        vec![
            ingredient("flour", flour_mappings()),
            ingredient("flour2", flour_mappings()),
        ],
        vec![],
    );

    assert_close(r.weight, 105.0, 0.5, "weight");
    assert_close(nutrient(&r, "208"), 364.0 + 18.2, 0.5, "kcal");
}

#[test]
fn measured_dredging_full_cost_twenty_percent_retained_excluded_from_basis() {
    let dredge = row("flour2", "flour", Some((1.0, "cup")), Some("for dredging"), None);
    let r = cost(
        vec![flour_cup(), dredge, frying_oil()],
        vec![
            ingredient("flour", flour_mappings()),
            ingredient("flour2", flour_mappings()),
            oil(),
        ],
        vec![],
    );

    // Basis is the normal flour's 100 g ONLY (oil = 15 g, not 19).
    // Weight: 100 + 20 (0.2 × 100) + 15 = 135.
    assert_close(r.weight, 135.0, 0.5, "weight");
    // kcal: 364 + 72.8 (0.2 × 364) + 132.6 = 569.4
    assert_close(nutrient(&r, "208"), 569.4, 0.5, "kcal");
    // Price: $1 + FULL $1 (discarding doesn't refund) + oil.
    assert_close(r.price, 2.075, 0.05, "price");
}

#[test]
fn measured_marinade_by_section_name_full_cost_fifteen_percent_retained() {
    // soy sauce: 100 g = 53 kcal; 100 g = $1
    let soy = ingredient(
        "soy",
        vec![
            mapping((100.0, "g"), (53.0, "kcal")),
            mapping((100.0, "g"), (1.0, "dollar")),
        ],
    );
    let r = cost(
        vec![
            flour_cup(),
            row("soy", "soy sauce", Some((100.0, "g")), None, Some("Marinade")),
        ],
        vec![ingredient("flour", flour_mappings()), soy],
        vec![],
    );

    assert_close(r.weight, 115.0, 0.5, "weight"); // 100 + 15 retained
    assert_close(nutrient(&r, "208"), 364.0 + 7.95, 0.5, "kcal");
    assert_close(r.price, 2.0, 0.005, "price"); // $1 + FULL $1
}

#[test]
fn unmeasured_marinade_stays_missing() {
    let soy = ingredient(
        "soy",
        vec![
            mapping((100.0, "g"), (53.0, "kcal")),
            mapping((100.0, "g"), (1.0, "dollar")),
        ],
    );
    let r = cost(
        vec![
            flour_cup(),
            row("soy", "soy sauce", None, None, Some("Marinade")),
        ],
        vec![ingredient("flour", flour_mappings()), soy],
        vec![],
    );

    assert_close(r.weight, 100.0, 0.5, "weight");
    assert!(r.missing_by_type.weight.contains(&"soy sauce".to_string()));
    assert!(r.missing_by_type.price.contains(&"soy sauce".to_string()));
}

#[test]
fn classifier_traps_refried_beans_and_stir_fry_sauce_are_normal() {
    let beans = ingredient("beans", vec![mapping((1.0, "can"), (400.0, "gram"))]);
    let stirfry = ingredient("stirfry", vec![mapping((1.0, "tbsp"), (15.0, "gram"))]);
    let r = cost(
        vec![
            row("beans", "refried beans", Some((1.0, "can")), None, None),
            row("stirfry", "stir-fry sauce", Some((2.0, "tbsp")), None, None),
        ],
        vec![beans, stirfry],
        vec![],
    );

    // Full measured weights — bare "fried"/"fry" substrings never classify.
    assert_close(r.weight, 430.0, 0.5, "weight");
}

// ─── Per-row results (the old per-row view helpers) ─────────────────────────

#[test]
fn estimated_rows_carry_the_estimate_and_flag() {
    let r = cost(
        vec![flour_cup(), frying_oil()],
        vec![ingredient("flour", flour_mappings()), oil()],
        vec![],
    );

    let oil_row = &r.rows[1];
    assert!(oil_row.estimated);
    assert_eq!(oil_row.usage, recipebridge::WIngredientUsage::FryingMedium);
    match &oil_row.gram {
        WMeasureResult::Ok(m) => assert_close(m.value, 15.0, 0.5, "oil est gram"),
        WMeasureResult::Err(e) => panic!("expected gram ok, got {e:?}"),
    }
    match &oil_row.nutrients {
        WNutrientsResult::Ok(n) => {
            let kcal = n.entries.iter().find(|e| e.code == "208").expect("kcal");
            assert_close(kcal.value, 132.6, 0.5, "oil est kcal");
        }
        WNutrientsResult::Err(e) => panic!("expected nutrients ok, got {e:?}"),
    }

    let flour_row = &r.rows[0];
    assert!(!flour_row.estimated);
}

#[test]
fn measured_fry_row_displays_est_weight_but_own_cost() {
    let measured_oil = row("oil", "neutral oil", Some((100.0, "g")), Some("for frying"), None);
    let r = cost(
        vec![flour_cup(), measured_oil],
        vec![ingredient("flour", flour_mappings()), oil()],
        vec![],
    );

    let oil_row = &r.rows[1];
    assert!(oil_row.estimated);
    // Displayed weight is the absorbed estimate, not the pot…
    match &oil_row.gram {
        WMeasureResult::Ok(m) => assert_close(m.value, 15.0, 0.5, "est gram"),
        WMeasureResult::Err(e) => panic!("expected gram ok, got {e:?}"),
    }
    // …while cost stays the full written amount.
    match &oil_row.price {
        WMeasureResult::Ok(m) => assert_close(m.value, 0.5, 0.005, "own cost"),
        WMeasureResult::Err(e) => panic!("expected price ok, got {e:?}"),
    }
    // The pot's own gram weight (100 g) feeds baker %, not the totals.
    assert_eq!(oil_row.own_gram, Some(100.0));
}

#[test]
fn baker_percentages_own_gram_based() {
    let mut flour_row = flour_cup();
    flour_row.is_flour = true;
    let water = ingredient("water", vec![mapping((1.0, "g"), (1.0, "gram"))]);
    let r = cost(
        vec![
            flour_row,
            row("water", "water", Some((200.0, "g")), None, None),
        ],
        vec![ingredient("flour", flour_mappings()), water],
        vec![],
    );

    let pct = |id: &str| {
        r.baker_percentages
            .iter()
            .find(|b| b.row_id == id)
            .and_then(|b| b.pct)
    };
    assert_close(pct("flour").expect("flour pct"), 100.0, 0.005, "flour pct");
    assert_close(pct("water").expect("water pct"), 200.0, 0.005, "water pct");
}

#[test]
fn baker_percentages_null_without_flour() {
    let r = cost(
        vec![flour_cup()],
        vec![ingredient("flour", flour_mappings())],
        vec![],
    );
    assert!(r.baker_percentages.iter().all(|b| b.pct.is_none()));
}

// ─── Diagnostics (the zod rowDiagnostic contract) ───────────────────────────

#[test]
fn records_usage_fired_rule_basis_and_values_in_input_order() {
    let r = cost(
        vec![flour_cup(), frying_oil()],
        vec![ingredient("flour", flour_mappings()), oil()],
        vec![],
    );

    assert_eq!(r.rows.len(), 2);
    let flour_diag = &r.rows[0];
    assert_eq!(flour_diag.name, "flour");
    assert_eq!(flour_diag.kind, WRowKind::Ingredient);
    assert_eq!(flour_diag.usage, recipebridge::WIngredientUsage::Normal);
    assert!(flour_diag.measured);
    assert_eq!(flour_diag.basis_grams, None);
    assert_eq!(flour_diag.plan.cost, ComponentSource::OwnFull);
    match &flour_diag.price {
        WMeasureResult::Ok(m) => {
            assert_eq!(m.value, 1.0);
            assert_eq!(m.unit, "$");
        }
        WMeasureResult::Err(e) => panic!("expected price ok, got {e:?}"),
    }

    let oil_diag = &r.rows[1];
    assert_eq!(oil_diag.name, "neutral oil");
    assert_eq!(oil_diag.usage, recipebridge::WIngredientUsage::FryingMedium);
    assert!(!oil_diag.measured);
    assert_eq!(oil_diag.basis_grams, Some(100.0));
    assert_eq!(
        oil_diag.plan.weight,
        ComponentSource::BasisFraction { fraction: 0.15 }
    );
}

#[test]
fn keeps_exact_error_strings() {
    let r = cost(
        vec![
            // No amounts on a normal row → "has no amounts" on all three.
            row("flour", "flour", None, None, None),
            // Measured but no product/mappings → per-measure conversion errors.
            row("mystery", "mystery", Some((1.0, "cup")), None, None),
        ],
        vec![
            ingredient("flour", flour_mappings()),
            empty_ingredient("mystery"),
        ],
        vec![],
    );

    let err_of = |m: &WMeasureResult| match m {
        WMeasureResult::Err(e) => e.error.clone(),
        WMeasureResult::Ok(_) => String::new(),
    };
    let no_amounts = &r.rows[0];
    let no_mappings = &r.rows[1];
    assert!(err_of(&no_amounts.price).contains("has no amounts"));
    assert!(err_of(&no_mappings.price).to_lowercase().contains("money"));
    assert!(err_of(&no_mappings.gram).to_lowercase().contains("weight"));
    match &no_mappings.nutrients {
        WNutrientsResult::Err(e) => {
            assert!(e.error.to_lowercase().contains("nutrient"));
        }
        WNutrientsResult::Ok(_) => panic!("expected nutrients err"),
    }
    // missingByType (names only) is unchanged for existing consumers.
    assert_eq!(r.missing_by_type.price, vec!["flour", "mystery"]);
}

#[test]
fn row_result_serde_matches_the_zod_row_diagnostic_shape() {
    let r = cost(
        vec![flour_cup(), frying_oil()],
        vec![ingredient("flour", flour_mappings()), oil()],
        vec![],
    );

    let flour_json = serde_json::to_value(&r.rows[0]).unwrap();
    assert_eq!(flour_json["sectionName"], serde_json::Value::Null);
    assert_eq!(flour_json["basisGrams"], serde_json::Value::Null);
    assert_eq!(flour_json["kind"], "ingredient");
    assert_eq!(flour_json["usage"], "normal");
    assert_eq!(flour_json["measured"], true);
    assert_eq!(flour_json["plan"]["cost"]["kind"], "own-full");
    assert_eq!(flour_json["price"]["ok"], true);
    assert_eq!(flour_json["price"]["unit"], "$");

    let oil_json = serde_json::to_value(&r.rows[1]).unwrap();
    assert_eq!(oil_json["usage"], "frying_medium");
    assert_eq!(oil_json["basisGrams"], 100.0);
    assert_eq!(oil_json["plan"]["weight"]["kind"], "basis-fraction");
    assert_eq!(oil_json["plan"]["weight"]["fraction"], 0.15);
}

// ─── Explain mode ────────────────────────────────────────────────────────────

#[test]
fn explain_attaches_paths_driven_by_own_or_estimated_amounts() {
    let r = cost_with(
        vec![flour_cup(), frying_oil()],
        vec![ingredient("flour", flour_mappings()), oil()],
        vec![],
        true,
    );

    // Measured flour: paths off its own 1 cup.
    let flour_paths = r.rows[0].paths.as_ref().expect("flour paths");
    assert!(flour_paths.money.as_ref().is_some_and(|p| !p.is_empty()));
    assert!(flour_paths.weight.as_ref().is_some_and(|p| !p.is_empty()));

    // Unmeasured fry oil: paths off the estimated 15 g.
    let oil_paths = r.rows[1].paths.as_ref().expect("oil paths");
    assert!(oil_paths.calories.as_ref().is_some_and(|p| !p.is_empty()));
    // No money→weight path confusion: oil's weight path exists (g→g, 0 hops).
    assert!(oil_paths.weight.is_some());
}

#[test]
fn explain_skips_rows_with_nothing_to_trace() {
    let r = cost_with(
        vec![row("mystery", "mystery", Some((1.0, "cup")), None, None)],
        vec![empty_ingredient("mystery")],
        vec![],
        true,
    );
    // No mappings → nothing to trace.
    assert!(r.rows[0].paths.is_none());
}

#[test]
fn explain_off_means_no_paths() {
    let r = cost(
        vec![flour_cup()],
        vec![ingredient("flour", flour_mappings())],
        vec![],
    );
    assert!(r.rows[0].paths.is_none());
}

#[test]
fn kcal_requires_unit_kcal_not_a_generic_nutrient_unit() {
    // Documents a key engine detail (ported from the old TS suite verbatim):
    // the kcal target maps to MeasureKind::Calories → Unit::KCal (built-in),
    // while a generic nutrient target maps to Unit::Other(...). A mapping
    // written as "kcal kcal" parses to Other("kcal kcal") and never reaches
    // the Calories node — only "kcal" (Unit::KCal) does.
    let bad = ingredient("bad", vec![mapping((100.0, "g"), (200.0, "kcal kcal"))]);
    let r = cost(
        vec![row("bad", "mystery powder", Some((100.0, "g")), None, None)],
        vec![bad],
        vec![],
    );
    assert_eq!(nutrient(&r, "208"), 0.0, "Other(\"kcal kcal\") must not match");

    let good = ingredient("good", vec![mapping((100.0, "g"), (200.0, "kcal"))]);
    let r = cost(
        vec![row("good", "mystery powder", Some((100.0, "g")), None, None)],
        vec![good],
        vec![],
    );
    assert_eq!(nutrient(&r, "208"), 200.0, "Unit::KCal matches Calories");
}

#[test]
fn unknown_root_id_is_an_error() {
    let input = WCostingInput {
        root_ids: vec!["nope".to_string()],
        recipes: vec![],
        ingredients: vec![],
        nutrient_targets: targets(),
        explain: false,
    };
    assert!(cost_recipes_impl(&input).is_err());
}

#[test]
fn multiple_roots_return_in_order() {
    let a = WCostingRecipe {
        id: "a".to_string(),
        recipe_yield: None,
        rows: vec![flour_cup()],
    };
    let b = WCostingRecipe {
        id: "b".to_string(),
        recipe_yield: None,
        rows: vec![],
    };
    let input = WCostingInput {
        root_ids: vec!["b".to_string(), "a".to_string()],
        recipes: vec![a, b],
        ingredients: vec![ingredient("flour", flour_mappings())],
        nutrient_targets: targets(),
        explain: false,
    };
    let result = cost_recipes_impl(&input).expect("costs");
    assert_eq!(result.recipes[0].recipe_id, "b");
    assert_eq!(result.recipes[1].recipe_id, "a");
    assert_eq!(result.recipes[0].total_ingredients, 0);
    assert_eq!(result.recipes[1].total_ingredients, 1);
}
