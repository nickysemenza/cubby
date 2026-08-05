//! Sub-recipe expansion suite — the needs-side mirror of `tests/costing.rs`'s
//! sub-recipe section. Same topologies (nesting, diamonds, cycles, partial
//! coverage, missing yield), asserting on flattened needs instead of totals.

// Integration tests are a separate crate, so lib.rs's `cfg_attr(test, …)` allow
// doesn't reach here — test assertions legitimately unwrap/expect.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use recipebridge::{
    WAmount, WExpandedNeed, WNeedsBlockReason, WNeedsInput, WNeedsLine, WNeedsRecipe, WNeedsRow,
    WRowKind, expand_recipe_needs_impl,
};

fn amount(unit: &str, value: f64) -> WAmount {
    WAmount {
        unit: unit.to_string(),
        value,
        upper_value: None,
    }
}

fn ingredient_row(id: &str, unit: &str, value: f64) -> WNeedsRow {
    WNeedsRow {
        kind: WRowKind::Ingredient,
        target_id: id.to_string(),
        name: id.to_string(),
        amounts: vec![amount(unit, value)],
    }
}

fn sub_row(id: &str, unit: &str, value: f64) -> WNeedsRow {
    WNeedsRow {
        kind: WRowKind::Recipe,
        target_id: id.to_string(),
        name: id.to_string(),
        amounts: vec![amount(unit, value)],
    }
}

fn recipe(id: &str, recipe_yield: Option<WAmount>, rows: Vec<WNeedsRow>) -> WNeedsRecipe {
    WNeedsRecipe {
        id: id.to_string(),
        name: id.to_string(),
        recipe_yield,
        rows,
    }
}

fn line(recipe_id: &str, scale: f64, line_index: u32) -> WNeedsLine {
    WNeedsLine {
        recipe_id: recipe_id.to_string(),
        scale,
        line_index,
    }
}

fn expand(input: WNeedsInput) -> (Vec<WExpandedNeed>, Vec<(String, WNeedsBlockReason)>) {
    let out = expand_recipe_needs_impl(&input).expect("expansion should succeed");
    let blocked = out
        .blocked
        .iter()
        .map(|b| (b.recipe_id.clone(), b.reason))
        .collect();
    (out.needs, blocked)
}

fn need<'a>(needs: &'a [WExpandedNeed], id: &str) -> &'a WExpandedNeed {
    needs
        .iter()
        .find(|n| n.ingredient_id == id)
        .unwrap_or_else(|| panic!("no need for {id}; got {:?}", ids(needs)))
}

fn ids(needs: &[WExpandedNeed]) -> Vec<&str> {
    needs.iter().map(|n| n.ingredient_id.as_str()).collect()
}

fn value(n: &WExpandedNeed) -> f64 {
    n.amount.as_ref().map(|a| a.value).unwrap_or(f64::NAN)
}

fn close(a: f64, b: f64) {
    assert!((a - b).abs() < 1e-6, "expected {b}, got {a}");
}

#[test]
fn expands_a_sub_recipe_scaled_by_yield() {
    // Sauce yields 4 cup from 400 g tomato; the parent asks for 2 cup → half.
    let (needs, blocked) = expand(WNeedsInput {
        lines: vec![line("parent", 1.0, 0)],
        recipes: vec![
            recipe(
                "parent",
                None,
                vec![
                    ingredient_row("pasta", "g", 100.0),
                    sub_row("sauce", "cup", 2.0),
                ],
            ),
            recipe(
                "sauce",
                Some(amount("cup", 4.0)),
                vec![ingredient_row("tomato", "g", 400.0)],
            ),
        ],
    });

    assert!(blocked.is_empty(), "{blocked:?}");
    close(value(need(&needs, "pasta")), 100.0);
    close(value(need(&needs, "tomato")), 200.0);
    assert_eq!(
        need(&needs, "tomato")
            .via
            .iter()
            .map(|v| v.recipe_id.as_str())
            .collect::<Vec<_>>(),
        vec!["sauce"],
    );
    // A direct row carries no provenance.
    assert!(need(&needs, "pasta").via.is_empty());
}

#[test]
fn multiplies_line_scale_through_nested_fractions() {
    // scale 2 × (half a sauce) × 400 g tomato = 400 g, two levels deep.
    let (needs, blocked) = expand(WNeedsInput {
        lines: vec![line("parent", 2.0, 0)],
        recipes: vec![
            recipe("parent", None, vec![sub_row("sauce", "cup", 2.0)]),
            recipe(
                "sauce",
                Some(amount("cup", 4.0)),
                vec![sub_row("base", "cup", 1.0)],
            ),
            recipe(
                "base",
                Some(amount("cup", 2.0)),
                vec![ingredient_row("tomato", "g", 400.0)],
            ),
        ],
    });

    assert!(blocked.is_empty(), "{blocked:?}");
    // 2 (line) × 0.5 (sauce) × 0.5 (base) × 400 g
    close(value(need(&needs, "tomato")), 200.0);
    assert_eq!(
        need(&needs, "tomato")
            .via
            .iter()
            .map(|v| v.recipe_id.as_str())
            .collect::<Vec<_>>(),
        vec!["sauce", "base"],
        "via is outermost-first",
    );
}

#[test]
fn resolves_a_mass_yield_against_a_gram_amount() {
    let (needs, blocked) = expand(WNeedsInput {
        lines: vec![line("parent", 1.0, 0)],
        recipes: vec![
            recipe("parent", None, vec![sub_row("dough", "g", 300.0)]),
            recipe(
                "dough",
                Some(amount("kg", 1.5)),
                vec![ingredient_row("flour", "g", 1000.0)],
            ),
        ],
    });

    assert!(blocked.is_empty(), "{blocked:?}");
    close(value(need(&needs, "flour")), 200.0); // 300/1500 × 1000
}

#[test]
fn blocks_a_non_convertible_reference() {
    let (needs, blocked) = expand(WNeedsInput {
        lines: vec![line("parent", 1.0, 0)],
        recipes: vec![
            recipe("parent", None, vec![sub_row("stew", "g", 200.0)]),
            recipe(
                "stew",
                Some(amount("servings", 8.0)),
                vec![ingredient_row("beef", "g", 900.0)],
            ),
        ],
    });

    assert!(ids(&needs).is_empty(), "{:?}", ids(&needs));
    assert_eq!(
        blocked,
        vec![("stew".into(), WNeedsBlockReason::Unscalable)]
    );
}

#[test]
fn blocks_a_zero_yield_without_emitting_a_saturated_need() {
    // The load-bearing one: a 1/0 graph edge saturates rather than going
    // infinite, so a missing guard produces a FINITE ~9.2e16 need that no
    // is_finite() check would catch. Assert on the absence of a need, not
    // merely on finiteness.
    let (needs, blocked) = expand(WNeedsInput {
        lines: vec![line("parent", 1.0, 0)],
        recipes: vec![
            recipe("parent", None, vec![sub_row("sauce", "cup", 2.0)]),
            recipe(
                "sauce",
                Some(amount("cup", 0.0)),
                vec![ingredient_row("tomato", "g", 400.0)],
            ),
        ],
    });

    assert!(ids(&needs).is_empty(), "{:?}", ids(&needs));
    assert_eq!(
        blocked,
        vec![("sauce".into(), WNeedsBlockReason::MissingYield)]
    );
}

#[test]
fn flags_a_yield_less_sub_recipe() {
    let (needs, blocked) = expand(WNeedsInput {
        lines: vec![line("parent", 1.0, 0)],
        recipes: vec![
            recipe("parent", None, vec![sub_row("sauce", "cup", 2.0)]),
            recipe("sauce", None, vec![ingredient_row("tomato", "g", 400.0)]),
        ],
    });

    assert!(ids(&needs).is_empty());
    assert_eq!(
        blocked,
        vec![("sauce".into(), WNeedsBlockReason::MissingYield)]
    );
}

#[test]
fn flags_a_sub_recipe_missing_from_the_closure() {
    let (needs, blocked) = expand(WNeedsInput {
        lines: vec![line("parent", 1.0, 0)],
        recipes: vec![recipe("parent", None, vec![sub_row("ghost", "cup", 1.0)])],
    });

    assert!(ids(&needs).is_empty());
    assert_eq!(
        blocked,
        vec![("ghost".into(), WNeedsBlockReason::UnknownRecipe)]
    );
}

#[test]
fn flags_an_amount_less_sub_recipe_reference() {
    let (_, blocked) = expand(WNeedsInput {
        lines: vec![line("parent", 1.0, 0)],
        recipes: vec![
            recipe(
                "parent",
                None,
                vec![WNeedsRow {
                    kind: WRowKind::Recipe,
                    target_id: "sauce".into(),
                    name: "sauce".into(),
                    amounts: vec![],
                }],
            ),
            recipe(
                "sauce",
                Some(amount("cup", 4.0)),
                vec![ingredient_row("tomato", "g", 400.0)],
            ),
        ],
    });

    assert_eq!(blocked, vec![("sauce".into(), WNeedsBlockReason::NoAmount)]);
}

#[test]
fn reports_an_amount_less_ingredient_rather_than_dropping_it() {
    let (needs, _) = expand(WNeedsInput {
        lines: vec![line("parent", 1.0, 0)],
        recipes: vec![recipe(
            "parent",
            None,
            vec![WNeedsRow {
                kind: WRowKind::Ingredient,
                target_id: "salt".into(),
                name: "salt".into(),
                amounts: vec![],
            }],
        )],
    });

    assert_eq!(ids(&needs), vec!["salt"]);
    assert!(need(&needs, "salt").amount.is_none());
}

#[test]
fn partial_expansion_still_contributes_what_it_could() {
    // The dough expands (flour lands) even though the dough's own poolish is
    // yield-less — and the block names the poolish, via the dough.
    let (needs, blocked) = expand(WNeedsInput {
        lines: vec![line("parent", 1.0, 0)],
        recipes: vec![
            recipe("parent", None, vec![sub_row("dough", "g", 500.0)]),
            recipe(
                "dough",
                Some(amount("g", 1000.0)),
                vec![
                    ingredient_row("flour", "g", 600.0),
                    sub_row("poolish", "g", 100.0),
                ],
            ),
            recipe("poolish", None, vec![ingredient_row("yeast", "g", 2.0)]),
        ],
    });

    close(value(need(&needs, "flour")), 300.0); // half a dough batch
    assert_eq!(
        blocked,
        vec![("poolish".into(), WNeedsBlockReason::MissingYield)]
    );
    let block = &expand_recipe_needs_impl(&WNeedsInput {
        lines: vec![line("parent", 1.0, 0)],
        recipes: vec![
            recipe("parent", None, vec![sub_row("dough", "g", 500.0)]),
            recipe(
                "dough",
                Some(amount("g", 1000.0)),
                vec![
                    ingredient_row("flour", "g", 600.0),
                    sub_row("poolish", "g", 100.0),
                ],
            ),
            recipe("poolish", None, vec![ingredient_row("yeast", "g", 2.0)]),
        ],
    })
    .expect("ok")
    .blocked[0];
    assert_eq!(
        block
            .via
            .iter()
            .map(|v| v.recipe_id.as_str())
            .collect::<Vec<_>>(),
        vec!["dough"],
        "a nested block is attributed through its parent",
    );
}

#[test]
fn diamond_dependencies_resolve_consistently() {
    // Same sub referenced twice in one parent — the memo path. Both hits must
    // produce the same amount, and both must appear.
    let (needs, blocked) = expand(WNeedsInput {
        lines: vec![line("parent", 1.0, 0)],
        recipes: vec![
            recipe(
                "parent",
                None,
                vec![sub_row("sauce", "cup", 2.0), sub_row("sauce", "cup", 2.0)],
            ),
            recipe(
                "sauce",
                Some(amount("cup", 4.0)),
                vec![ingredient_row("tomato", "g", 400.0)],
            ),
        ],
    });

    assert!(blocked.is_empty(), "{blocked:?}");
    let tomatoes: Vec<f64> = needs
        .iter()
        .filter(|n| n.ingredient_id == "tomato")
        .map(value)
        .collect();
    assert_eq!(tomatoes.len(), 2);
    for v in tomatoes {
        close(v, 200.0);
    }
}

#[test]
fn guards_against_cycles_without_hanging() {
    // a → b → a. Must terminate, contribute ZERO from the cyclic branch (a
    // zero that reads as "covered" is the failure mode), and flag it once.
    let (needs, blocked) = expand(WNeedsInput {
        lines: vec![line("a", 1.0, 0)],
        recipes: vec![
            recipe(
                "a",
                Some(amount("cup", 2.0)),
                vec![sub_row("b", "cup", 1.0), ingredient_row("salt", "g", 5.0)],
            ),
            recipe(
                "b",
                Some(amount("cup", 2.0)),
                vec![sub_row("a", "cup", 1.0)],
            ),
        ],
    });

    // The non-cyclic part of `a` still lands.
    close(value(need(&needs, "salt")), 5.0);
    assert_eq!(blocked, vec![("a".into(), WNeedsBlockReason::Cycle)]);
}

#[test]
fn sub_recipe_referenced_both_inside_and_outside_a_cycle() {
    // The memo/taint interaction: `s` is reached directly (clean, cacheable)
    // AND through a guarded cycle (t → u → t). Neither may poison the other.
    let (needs, blocked) = expand(WNeedsInput {
        lines: vec![line("root", 1.0, 0)],
        recipes: vec![
            recipe(
                "root",
                None,
                vec![sub_row("s", "cup", 1.0), sub_row("t", "cup", 1.0)],
            ),
            recipe(
                "s",
                Some(amount("cup", 2.0)),
                vec![ingredient_row("sugar", "g", 100.0)],
            ),
            recipe(
                "t",
                Some(amount("cup", 2.0)),
                vec![sub_row("u", "cup", 1.0), sub_row("s", "cup", 1.0)],
            ),
            recipe(
                "u",
                Some(amount("cup", 2.0)),
                vec![sub_row("t", "cup", 1.0)],
            ),
        ],
    });

    // s via root: 0.5 × 100 = 50. s via t: 0.5 (t) × 0.5 (s) × 100 = 25.
    let sugars: Vec<f64> = needs
        .iter()
        .filter(|n| n.ingredient_id == "sugar")
        .map(value)
        .collect();
    assert_eq!(sugars.len(), 2, "both routes to s contribute: {sugars:?}");
    assert!(sugars.iter().any(|v| (v - 50.0).abs() < 1e-6), "{sugars:?}");
    assert!(sugars.iter().any(|v| (v - 25.0).abs() < 1e-6), "{sugars:?}");
    assert_eq!(blocked, vec![("t".into(), WNeedsBlockReason::Cycle)]);
}

#[test]
fn attributes_every_need_to_its_own_line() {
    let (needs, _) = expand(WNeedsInput {
        lines: vec![line("parent", 1.0, 0), line("parent", 3.0, 7)],
        recipes: vec![recipe(
            "parent",
            None,
            vec![ingredient_row("flour", "g", 100.0)],
        )],
    });

    let by_line: Vec<(u32, f64)> = needs.iter().map(|n| (n.line_index, value(n))).collect();
    assert_eq!(by_line.len(), 2);
    assert!(by_line.contains(&(0, 100.0)), "{by_line:?}");
    assert!(by_line.contains(&(7, 300.0)), "{by_line:?}");
}

#[test]
fn skips_a_line_with_a_non_positive_scale() {
    let (needs, _) = expand(WNeedsInput {
        lines: vec![line("parent", 0.0, 0), line("parent", f64::NAN, 1)],
        recipes: vec![recipe(
            "parent",
            None,
            vec![ingredient_row("flour", "g", 100.0)],
        )],
    });

    assert!(ids(&needs).is_empty());
}

#[test]
fn errs_on_an_unknown_root_recipe() {
    let err = expand_recipe_needs_impl(&WNeedsInput {
        lines: vec![line("nope", 1.0, 0)],
        recipes: vec![],
    });

    assert!(
        err.is_err(),
        "an unknown root is a caller contract violation"
    );
}

#[test]
fn empty_input_expands_to_nothing() {
    let (needs, blocked) = expand(WNeedsInput {
        lines: vec![],
        recipes: vec![],
    });
    assert!(needs.is_empty());
    assert!(blocked.is_empty());
}
