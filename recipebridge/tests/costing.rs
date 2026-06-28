//! Parity suite for the costing engine — the `calculateTotals` cases from
//! apps/web/src/lib/recipe-costing.unit.test.ts, expected values preserved.
//! The TS suite re-verifies the same numbers through the wasm boundary; this
//! file is the native-target net that runs in CI without a wasm runtime.

// Integration tests are a separate crate, so lib.rs's `cfg_attr(test, …)` allow
// doesn't reach here — test assertions legitimately unwrap/expect.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use recipebridge::{
    ComponentSource, WAmount, WCostingIngredient, WCostingInput, WCostingRecipe, WCostingRow,
    WMeasureResult, WNutrientTarget, WNutrientsResult, WProductInput, WRecipeCosting, WRowKind,
    WSourceMetadata, WUnitMapping, cost_recipes_impl,
};

// ─── Fixture builders (mirror the TS test builders) ─────────────────────────

fn amount(value: f64, unit: &str) -> WAmount {
    WAmount {
        unit: unit.to_string(),
        value,
        upper_value: None,
    }
}

fn mapping(a: (f64, &str), b: (f64, &str)) -> WUnitMapping {
    WUnitMapping {
        a: amount(a.0, a.1),
        b: amount(b.0, b.1),
        source: Some("test".to_string()),
        source_metadata: Some(WSourceMetadata::Manual),
    }
}

/// An ingredient backed by one product carrying `mappings` (no food/price —
/// the TS tests' nutrient edges are stored mappings too).
fn ingredient(id: &str, mappings: Vec<WUnitMapping>) -> WCostingIngredient {
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
        amounts: amt.map(|(v, u)| amount(v, u)).into_iter().collect(),
        modifier: modifier.map(String::from),
        raw_line: None,
        section_name: section.map(String::from),
    }
}

fn sub_recipe_row(sub_id: &str, amt: (f64, &str)) -> WCostingRow {
    WCostingRow {
        id: format!("link-{sub_id}"),
        kind: WRowKind::Recipe,
        target_id: sub_id.to_string(),
        name: "sub-recipe".to_string(),
        amounts: vec![amount(amt.0, amt.1)],
        modifier: None,
        raw_line: None,
        section_name: None,
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

/// Assert a `WMeasureResult` is `Ok` and within `tol` of `expected`. Collapses
/// the repeated `match { Ok(m) => assert_close(...), Err(e) => panic!(...) }`.
fn assert_measure_close(result: &WMeasureResult, expected: f64, tol: f64, what: &str) {
    match result {
        WMeasureResult::Ok(m) => assert_close(m.value, expected, tol, what),
        WMeasureResult::Err(e) => panic!("expected {what} ok, got {e:?}"),
    }
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
fn flour_mappings() -> Vec<WUnitMapping> {
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
fn partial_sub_recipe_totals_still_contribute_but_mark_parent_missing() {
    let tomato = ingredient(
        "tomato",
        vec![
            mapping((1.0, "cup"), (100.0, "gram")),
            mapping((100.0, "g"), (50.0, "kcal")),
        ],
    );
    let sauce = WCostingRecipe {
        id: "sauce".to_string(),
        recipe_yield: Some(amount(4.0, "cup")),
        rows: vec![row("tomato", "tomato", Some((4.0, "cup")), None, None)],
    };

    let r = cost(
        vec![sub_recipe_row("sauce", (2.0, "cup"))],
        vec![tomato],
        vec![sauce],
    );

    assert_eq!(r.price, 0.0);
    assert_close(r.weight, 200.0, 0.05, "weight");
    assert_close(nutrient(&r, "208"), 100.0, 0.05, "kcal");
    assert_eq!(r.missing_by_type.price, vec!["sub-recipe"]);
    assert!(r.missing_by_type.weight.is_empty());
    assert!(r.missing_by_type.nutrients.is_empty());
    assert!(r.rows[0].missing.price);
    assert!(!r.rows[0].missing.weight);
    assert!(!r.rows[0].missing.nutrients);
}

#[test]
fn partial_sub_recipe_missing_flags_propagate_through_nested_recipes() {
    let tomato = ingredient(
        "tomato",
        vec![
            mapping((1.0, "cup"), (100.0, "gram")),
            mapping((100.0, "g"), (50.0, "kcal")),
        ],
    );
    let sauce = WCostingRecipe {
        id: "sauce".to_string(),
        recipe_yield: Some(amount(4.0, "cup")),
        rows: vec![row("tomato", "tomato", Some((4.0, "cup")), None, None)],
    };
    let composed = WCostingRecipe {
        id: "composed".to_string(),
        recipe_yield: Some(amount(1.0, "batch")),
        rows: vec![sub_recipe_row("sauce", (2.0, "cup"))],
    };

    let r = cost(
        vec![sub_recipe_row("composed", (1.0, "batch"))],
        vec![tomato],
        vec![sauce, composed],
    );

    assert_eq!(r.price, 0.0);
    assert_close(r.weight, 200.0, 0.05, "weight");
    assert_close(nutrient(&r, "208"), 100.0, 0.05, "kcal");
    assert_eq!(r.missing_by_type.price, vec!["sub-recipe"]);
    assert!(r.missing_by_type.weight.is_empty());
    assert!(r.missing_by_type.nutrients.is_empty());
    assert!(r.rows[0].missing.price);
    assert!(!r.rows[0].missing.weight);
    assert!(!r.rows[0].missing.nutrients);
}

#[test]
fn diamond_sub_recipe_dependencies_resolve_consistently() {
    // root uses the same yielded sub twice (memoized after the first
    // encounter) — both rows must contribute identical, correct values.
    let tomato = ingredient(
        "tomato",
        vec![
            mapping((1.0, "cup"), (100.0, "gram")),
            mapping((1.0, "cup"), (1.0, "dollar")),
        ],
    );
    let sauce = WCostingRecipe {
        id: "sauce".to_string(),
        recipe_yield: Some(amount(4.0, "cup")),
        rows: vec![row("tomato", "tomato", Some((4.0, "cup")), None, None)],
    };
    let mut second = sub_recipe_row("sauce", (2.0, "cup"));
    second.id = "link-sauce-2".to_string();

    let r = cost(
        vec![sub_recipe_row("sauce", (2.0, "cup")), second],
        vec![tomato],
        vec![sauce],
    );

    // Each 2-cup row = half of the sauce's $4 / 400 g.
    assert_close(r.price, 4.0, 0.005, "price");
    assert_close(r.weight, 400.0, 0.05, "weight");
    assert!(r.missing_by_type.price.is_empty());
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
    let rec_a = &result.recipes[0];
    // The cycle resolves to a *missing* contribution, not just "finite": A's only
    // row (sub-recipe B) can't be costed because B re-enters A, so A's total is
    // exactly 0 — a regression that terminated but produced a bogus non-zero
    // number would pass an is_finite()-only check.
    assert!(rec_a.price.is_finite());
    assert_eq!(rec_a.price, 0.0, "cycle → missing contribution, total 0");
    assert_eq!(rec_a.weight, 0.0, "cycle → missing contribution, weight 0");
}

#[test]
fn sub_recipe_referenced_both_inside_and_outside_a_cycle() {
    // The hardest memo/taint topology. root references S directly (clean) AND
    // references T, whose subtree is cyclic (T→U→T) but also reaches the same
    // S (U→S). S must resolve to identical values in both the clean direct
    // encounter and the tainted subtree — the cache (filled clean, read under
    // taint) must neither poison S nor be poisoned by the cycle.
    let tomato = ingredient(
        "tomato",
        vec![
            mapping((1.0, "cup"), (100.0, "gram")),
            mapping((1.0, "cup"), (1.0, "dollar")),
        ],
    );
    // S "sauce": yields 4 cup; 4 cup tomato → $4 / 400 g. 2 cup of it = $2 / 200 g.
    let sauce = WCostingRecipe {
        id: "S".to_string(),
        recipe_yield: Some(amount(4.0, "cup")),
        rows: vec![row("tomato", "tomato", Some((4.0, "cup")), None, None)],
    };
    // U "u": yields 1 batch; references T (closes the cycle → guarded → missing)
    // and S (2 cup → $2 / 200 g). So U = $2 / 200 g.
    let u = WCostingRecipe {
        id: "U".to_string(),
        recipe_yield: Some(amount(1.0, "batch")),
        rows: vec![
            sub_recipe_row("T", (1.0, "batch")),
            sub_recipe_row("S", (2.0, "cup")),
        ],
    };
    // T "t": yields 1 batch; references U (1 batch → full U = $2 / 200 g).
    let t = WCostingRecipe {
        id: "T".to_string(),
        recipe_yield: Some(amount(1.0, "batch")),
        rows: vec![sub_recipe_row("U", (1.0, "batch"))],
    };

    // root: direct S row FIRST (fills the clean cache), then the cyclic T branch
    // (reaches S again via U, as a cache hit).
    let mut direct_s = sub_recipe_row("S", (2.0, "cup"));
    direct_s.id = "link-S-direct".to_string();
    let r = cost(
        vec![direct_s, sub_recipe_row("T", (1.0, "batch"))],
        vec![tomato],
        vec![sauce, u, t],
    );

    // Direct S row resolves to $2 / 200 g — the cache value is correct.
    assert_measure_close(&r.rows[0].price, 2.0, 0.005, "direct S price");
    // Both branches contribute $2 / 200 g (S directly + T→U→S), so the cycle is
    // broken cleanly and S is identical across the clean/tainted boundary. The
    // cyclic branch still marks the parent row incomplete: it contributed the
    // non-cyclic numeric portion, but part of its child graph failed.
    assert_close(r.price, 4.0, 0.005, "total price");
    assert_close(r.weight, 400.0, 0.05, "total weight");
    assert_eq!(r.missing_by_type.price, vec!["sub-recipe"]);
    assert_eq!(r.missing_by_type.weight, vec!["sub-recipe"]);
}

#[test]
fn empty_recipe_costs_to_zero() {
    let r = cost(vec![], vec![], vec![]);
    assert_eq!(r.total_ingredients, 0);
    assert_eq!(r.price, 0.0);
    assert_eq!(r.weight, 0.0);
    assert!(r.nutrients.is_empty());
    assert!(r.rows.is_empty());
    assert!(r.baker_percentages.is_empty());
    assert!(r.missing_by_type.price.is_empty());
    assert!(r.missing_by_type.weight.is_empty());
    assert!(r.missing_by_type.nutrients.is_empty());
}

#[test]
fn flags_yield_less_sub_recipe_as_missing() {
    let sauce = WCostingRecipe {
        id: "sauce".to_string(),
        recipe_yield: None,
        rows: vec![row("tomato", "tomato", Some((1.0, "cup")), None, None)],
    };
    let r = cost(
        vec![sub_recipe_row("sauce", (2.0, "cup"))],
        vec![],
        vec![sauce],
    );

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
    let measured_oil = row(
        "oil",
        "neutral oil",
        Some((100.0, "g")),
        Some("for frying"),
        None,
    );
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
fn prefers_stated_weight_over_volume_sharing_one_basis() {
    // Flour written as both "2 cups" and "8½ oz", with only a cup→g density
    // mapping (no oz mapping). The canonical amount is the ounce: weight resolves
    // via the mass identity to 241 g (not 2×100 = 200 g from the cup density),
    // and calories ride that same 241 g basis — not a mix.
    let flour_row = WCostingRow {
        id: "flour".to_string(),
        kind: WRowKind::Ingredient,
        target_id: "flour".to_string(),
        name: "flour".to_string(),
        amounts: vec![amount(2.0, "cup"), amount(8.5, "oz")],
        modifier: None,
        raw_line: None,
        section_name: None,
    };
    let flour = ingredient(
        "flour",
        vec![
            mapping((1.0, "cup"), (100.0, "gram")),
            mapping((100.0, "g"), (364.0, "kcal")),
        ],
    );

    let r = cost(vec![flour_row], vec![flour], vec![]);

    assert_close(r.weight, 241.0, 0.6, "weight"); // 8.5 oz, not the 200 g cup density
    assert_close(nutrient(&r, "208"), 877.0, 2.0, "kcal"); // 241 g basis, not 200 g
}

#[test]
fn frying_medium_with_no_mapping_fails_gracefully() {
    let r = cost(
        vec![flour_cup(), frying_oil()],
        vec![
            ingredient("flour", flour_mappings()),
            empty_ingredient("oil"),
        ],
        vec![],
    );

    // 100 g flour + ~15 g estimated absorbed oil. The oil has no mappings, but
    // its estimated weight is already in grams, so it resolves via the unit
    // engine's mass identity (no density needed) and counts toward total weight —
    // consistent with a mapped frying medium. Cost/nutrients still can't resolve
    // (no food link), so the oil stays in missing_by_type.nutrients.
    assert_close(r.weight, 115.0, 0.5, "weight");
    assert_close(nutrient(&r, "208"), 364.0, 0.5, "kcal");
    assert!(
        r.missing_by_type
            .nutrients
            .contains(&"neutral oil".to_string())
    );
}

#[test]
fn estimate_only_recipe_has_no_basis() {
    let r = cost(vec![frying_oil()], vec![oil()], vec![]);

    assert_eq!(r.weight, 0.0);
    assert!(r.missing_by_type.price.contains(&"neutral oil".to_string()));
    assert!(
        r.missing_by_type
            .weight
            .contains(&"neutral oil".to_string())
    );
    assert!(
        r.missing_by_type
            .nutrients
            .contains(&"neutral oil".to_string())
    );
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
        vec![
            flour_cup(),
            row("salt", "salt", None, Some("to taste"), None),
        ],
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
    let dredge = row(
        "flour2",
        "flour",
        Some((1.0, "cup")),
        Some("for dredging"),
        None,
    );
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
            row(
                "soy",
                "soy sauce",
                Some((100.0, "g")),
                None,
                Some("Marinade"),
            ),
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
    assert_measure_close(&oil_row.gram, 15.0, 0.5, "oil est gram");
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
    let measured_oil = row(
        "oil",
        "neutral oil",
        Some((100.0, "g")),
        Some("for frying"),
        None,
    );
    let r = cost(
        vec![flour_cup(), measured_oil],
        vec![ingredient("flour", flour_mappings()), oil()],
        vec![],
    );

    let oil_row = &r.rows[1];
    assert!(oil_row.estimated);
    // Displayed weight is the absorbed estimate, not the pot…
    assert_measure_close(&oil_row.gram, 15.0, 0.5, "est gram");
    // …while cost stays the full written amount.
    assert_measure_close(&oil_row.price, 0.5, 0.005, "own cost");
    // The pot's own gram weight (100 g) feeds baker %, not the totals.
    assert_eq!(oil_row.own_gram, Some(100.0));
}

#[test]
fn baker_percentages_own_gram_based() {
    let flour_row = flour_cup();
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
fn baker_percentages_use_pre_estimate_gram_for_estimated_flour_rows() {
    // A measured "for dredging" flour row is estimated (20% retained weight),
    // but baker % must use its PRE-estimate own gram (the written 100 g), not
    // the 20 g retained. Two flour rows of 100 g each → flour basis 200 g, so
    // each is 50%. If the retained estimate (20 g) fed the denominator, the
    // normal flour would read ~83% instead.
    let flour_row = flour_cup();
    let dredge_row = row(
        "flour2",
        "flour",
        Some((1.0, "cup")),
        Some("for dredging"),
        None,
    );

    let r = cost(
        vec![flour_row, dredge_row],
        vec![
            ingredient("flour", flour_mappings()),
            ingredient("flour2", flour_mappings()),
        ],
        vec![],
    );

    // The dredge row is estimated, displays 20 g, but reports own_gram = 100 g.
    let dredge = &r.rows[1];
    assert!(dredge.estimated);
    assert_eq!(dredge.own_gram, Some(100.0));
    assert_measure_close(&dredge.gram, 20.0, 0.5, "dredge displayed gram");

    let pct = |id: &str| {
        r.baker_percentages
            .iter()
            .find(|b| b.row_id == id)
            .and_then(|b| b.pct)
    };
    assert_close(pct("flour").expect("flour pct"), 50.0, 0.005, "flour pct");
    assert_close(
        pct("flour2").expect("dredge pct"),
        50.0,
        0.005,
        "dredge pct",
    );
}

#[test]
fn baker_percentages_null_without_flour() {
    // No flour in the recipe → no baker's-% base, so every row is null. (The
    // engine now classifies flour by name, so this must use a non-flour row.)
    let water = ingredient("water", vec![mapping((1.0, "g"), (1.0, "gram"))]);
    let r = cost(
        vec![row("water", "water", Some((200.0, "g")), None, None)],
        vec![water],
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
    assert_eq!(
        nutrient(&r, "208"),
        0.0,
        "Other(\"kcal kcal\") must not match"
    );

    let good = ingredient("good", vec![mapping((100.0, "g"), (200.0, "kcal"))]);
    let r = cost(
        vec![row(
            "good",
            "mystery powder",
            Some((100.0, "g")),
            None,
            None,
        )],
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

// ─── Amount ranges (min–max) ────────────────────────────────────────────────

fn ranged_amount(lower: f64, upper: f64, unit: &str) -> WAmount {
    WAmount {
        unit: unit.to_string(),
        value: lower,
        upper_value: Some(upper),
    }
}

fn ranged_row(id: &str, name: &str, lower: f64, upper: f64, unit: &str) -> WCostingRow {
    WCostingRow {
        id: id.to_string(),
        kind: WRowKind::Ingredient,
        target_id: id.to_string(),
        name: name.to_string(),
        amounts: vec![ranged_amount(lower, upper, unit)],
        modifier: None,
        raw_line: None,
        section_name: None,
    }
}

fn nutrient_upper(r: &WRecipeCosting, code: &str) -> Option<f64> {
    r.nutrients
        .iter()
        .find(|n| n.code == code)
        .and_then(|n| n.upper_value)
}

#[test]
fn ranged_amount_yields_ranged_totals() {
    // flour "2–3 cup": 1 cup = 100 g = $1 = 364 kcal = 10 g protein.
    // price $2–3, weight 200–300 g, kcal 728–1092, protein 20–30 g.
    let r = cost(
        vec![ranged_row("flour", "flour", 2.0, 3.0, "cup")],
        vec![ingredient("flour", flour_mappings())],
        vec![],
    );

    assert_close(r.price, 2.0, 0.005, "price lower");
    assert_close(
        r.price_upper.expect("price ranged"),
        3.0,
        0.005,
        "price upper",
    );
    assert_close(r.weight, 200.0, 0.5, "weight lower");
    assert_close(
        r.weight_upper.expect("weight ranged"),
        300.0,
        0.5,
        "weight upper",
    );
    assert_close(nutrient(&r, "208"), 728.0, 1.0, "kcal lower");
    assert_close(
        nutrient_upper(&r, "208").expect("kcal ranged"),
        1092.0,
        1.0,
        "kcal upper",
    );
}

#[test]
fn point_amount_leaves_totals_unranged() {
    // A non-ranged recipe must not carry any upper bound (renders as one number).
    let r = cost(
        vec![flour_cup()],
        vec![ingredient("flour", flour_mappings())],
        vec![],
    );
    assert!(r.price_upper.is_none(), "price_upper: {:?}", r.price_upper);
    assert!(
        r.weight_upper.is_none(),
        "weight_upper: {:?}",
        r.weight_upper
    );
    assert!(
        nutrient_upper(&r, "208").is_none(),
        "kcal upper should be absent"
    );
}

#[test]
fn partial_range_sums_lower_and_upper_independently() {
    // One ranged row (flour 2–3 cup → $2–3) + one point row (flour 1 cup → $1).
    // Totals: lower $3, upper $4.
    let r = cost(
        vec![
            ranged_row("flour", "flour", 2.0, 3.0, "cup"),
            row("flour2", "flour", Some((1.0, "cup")), None, None),
        ],
        vec![
            ingredient("flour", flour_mappings()),
            ingredient("flour2", flour_mappings()),
        ],
        vec![],
    );
    assert_close(r.price, 3.0, 0.005, "price lower 2+1");
    assert_close(
        r.price_upper.expect("price ranged"),
        4.0,
        0.005,
        "price upper 3+1",
    );
}

#[test]
fn ranged_sub_recipe_rolls_up_scaled() {
    // Sub-recipe "dough" yields 1 batch and contains flour "2–3 cup" → $2–3 per
    // batch. Parent uses 2 batches → $4–6. The range rides the yield-mapping edge
    // through the (now range-aware) unit graph.
    let dough = WCostingRecipe {
        id: "dough".to_string(),
        recipe_yield: Some(amount(1.0, "batch")),
        rows: vec![ranged_row("flour", "flour", 2.0, 3.0, "cup")],
    };
    let r = cost(
        vec![sub_recipe_row("dough", (2.0, "batch"))],
        vec![ingredient("flour", flour_mappings())],
        vec![dough],
    );
    assert_close(r.price, 4.0, 0.01, "parent price lower 2×2");
    assert_close(
        r.price_upper.expect("price ranged"),
        6.0,
        0.01,
        "parent price upper 2×3",
    );
}
