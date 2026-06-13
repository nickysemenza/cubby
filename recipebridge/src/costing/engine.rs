//! The two-pass recipe costing engine. Port of `calculateTotals` (+ the per-row
//! view helpers) from the old apps/web/src/lib/recipe-costing.ts.
//!
//! Parity notes (the TS engine's observable behavior, preserved deliberately):
//! - All unit *conversions* run through the same `ingredient` graph code the TS
//!   engine called via WASM (including its integer rounding at the normalized
//!   unit); fraction scaling, basis accumulation, and totals sum in f64, in the
//!   same order (pass-1 rows in input order, then pass-2 rows).
//! - Error strings are verbatim ("ingredient {id} has no amounts",
//!   "no basis for estimate", …) — diagnostics consumers match on them.
//! - Sub-recipe totals are memoized per engine (per `cost_recipes` call) —
//!   identical results to the TS per-encounter recursion, minus the redundant
//!   recomputes. Only cycle-free computations are cached: a result produced
//!   under a fired cycle guard depends on the visited set, not just the id.

use std::cell::{OnceCell, RefCell};
use std::collections::{HashMap, HashSet};

use ingredient::classify_usage;
use ingredient::unit::{
    convert_measure_with_graph, convert_measure_with_graph_explained, make_graph, Measure,
    MeasureGraph, MeasureKind,
};
use ingredient::usage::IngredientUsage;

use super::consumption::{plan_for, ComponentSource, PlanTrio};
use super::types::{
    WBakerPct, WCostingInput, WCostingRecipe, WCostingRow, WMeasureOk, WMeasureResult,
    WMissingByType, WNutrientAmount, WNutrientsOk, WNutrientsResult, WRecipeCosting, WRowKind,
    WRowPaths, WRowResult,
};
use crate::food_mappings::product_mappings;
use crate::WConversionStep;

/// One recipe row paired with its resolved usage and the consumption plan that
/// usage implies. Built up front (before the two resolution passes) so each
/// pass reads a stable per-row plan.
struct Planned<'r> {
    row: &'r WCostingRow,
    usage: IngredientUsage,
    plan: PlanTrio,
}

/// Classify every row's usage + consumption plan, in input order. Sub-recipe
/// rows are always Normal (their internals already applied their own model);
/// ingredient rows are classified from the resolved name + stored parts.
fn classify_planned_rows(recipe: &WCostingRecipe) -> Vec<Planned<'_>> {
    recipe
        .rows
        .iter()
        .map(|row| {
            let usage = match row.kind {
                WRowKind::Recipe => IngredientUsage::Normal,
                WRowKind::Ingredient => classify_usage(
                    &row.name,
                    row.modifier.as_deref(),
                    row.raw_line.as_deref(),
                    row.section_name.as_deref(),
                ),
            };
            let plan = plan_for(usage, !row.amounts.is_empty());
            Planned { row, usage, plan }
        })
        .collect()
}

/// The amount a row's measures resolve from: a mass amount when present (the
/// stated weight, resolved exactly via the unit engine's mass identity), else
/// the first written amount. None only for an amount-less row.
fn canonical_amount(amounts: &[Measure]) -> Option<&Measure> {
    amounts
        .iter()
        .find(|m| matches!(m.kind(), Ok(MeasureKind::Weight)))
        .or_else(|| amounts.first())
}

/// A resolved measure's f64 view (value extracted immediately after the
/// rational conversion, like the old WASM boundary did).
#[derive(Clone, Debug)]
struct MeasureVal {
    value: f64,
    unit: String,
    upper: Option<f64>,
}

impl From<Measure> for MeasureVal {
    fn from(m: Measure) -> Self {
        Self {
            value: m.value(),
            unit: m.unit().to_str().into_owned(),
            upper: m.upper_value(),
        }
    }
}

type MeasureRes = Result<MeasureVal, String>;
type NutrientsRes = Result<Vec<(String, f64)>, String>;

/// Price, weight, and nutrient results for one row (the old IngredientPriceInfo).
#[derive(Clone, Debug)]
struct Trio {
    price: MeasureRes,
    gram: MeasureRes,
    nutrients: NutrientsRes,
}

impl Trio {
    fn all_err(e: impl Into<String>) -> Self {
        let e = e.into();
        Self {
            price: Err(e.clone()),
            gram: Err(e.clone()),
            nutrients: Err(e),
        }
    }
}

fn scale_measure(r: &MeasureRes, fraction: f64) -> MeasureRes {
    match r {
        Ok(v) => Ok(MeasureVal {
            value: v.value * fraction,
            unit: v.unit.clone(),
            upper: v.upper.map(|u| u * fraction),
        }),
        Err(e) => Err(e.clone()),
    }
}

fn scale_nutrients(r: &NutrientsRes, fraction: f64) -> NutrientsRes {
    match r {
        Ok(entries) => Ok(entries
            .iter()
            .map(|(code, v)| (code.clone(), v * fraction))
            .collect()),
        Err(e) => Err(e.clone()),
    }
}

fn to_measure_result(r: &MeasureRes) -> WMeasureResult {
    match r {
        Ok(v) => WMeasureResult::Ok(WMeasureOk {
            ok: true,
            value: v.value,
            unit: v.unit.clone(),
            upper_value: v.upper,
        }),
        Err(e) => WMeasureResult::err(e.clone()),
    }
}

fn to_nutrients_result(r: &NutrientsRes) -> WNutrientsResult {
    match r {
        Ok(entries) => WNutrientsResult::Ok(WNutrientsOk {
            ok: true,
            entries: entries
                .iter()
                .map(|(code, value)| WNutrientAmount {
                    code: code.clone(),
                    value: *value,
                })
                .collect(),
        }),
        Err(e) => WNutrientsResult::err(e.clone()),
    }
}

/// One nutrient conversion target, kcal pre-resolved to `Calories`
/// (Unit::KCal ≠ Unit::Other("kcal") in the graph).
struct Target {
    code: String,
    unit: String,
    kind: MeasureKind,
}

/// Per-ingredient context: mapping pairs synthesized once (stored rows + food
/// edges + price edge), petgraph built lazily once and reused across the own
/// trio, the estimate trio, and explain paths — replacing the TS LRU.
struct IngredientCtx {
    pairs: Vec<(Measure, Measure)>,
    graph: OnceCell<MeasureGraph>,
}

impl IngredientCtx {
    fn new(pairs: Vec<(Measure, Measure)>) -> Self {
        Self {
            pairs,
            graph: OnceCell::new(),
        }
    }

    fn graph(&self) -> &MeasureGraph {
        self.graph.get_or_init(|| make_graph(&self.pairs))
    }
}

/// A costed sub-recipe's totals, the inputs to its yield mappings.
#[derive(Clone)]
struct SubTotals {
    price: f64,
    weight: f64,
    nutrients: Vec<(String, f64)>,
}

pub(crate) struct Engine<'a> {
    recipes: HashMap<&'a str, &'a WCostingRecipe>,
    ingredients: HashMap<&'a str, IngredientCtx>,
    targets: Vec<Target>,
    /// Fallback for rows referencing an ingredient that wasn't provided —
    /// conversions fail exactly like the TS `mappings = []` path.
    empty_ctx: IngredientCtx,
    /// Sub-recipe totals memo. Cycle-tainted computations are never cached
    /// (their value depends on where in the recursion they were observed).
    sub_totals: RefCell<HashMap<String, SubTotals>>,
}

impl<'a> Engine<'a> {
    pub fn new(input: &'a WCostingInput) -> Self {
        Self {
            recipes: input.recipes.iter().map(|r| (r.id.as_str(), r)).collect(),
            ingredients: input
                .ingredients
                .iter()
                .map(|i| {
                    let pairs = i
                        .products
                        .iter()
                        .flat_map(product_mappings)
                        .map(|m| m.to_pair())
                        .collect();
                    (i.id.as_str(), IngredientCtx::new(pairs))
                })
                .collect(),
            targets: input
                .nutrient_targets
                .iter()
                .map(|t| Target {
                    code: t.code.clone(),
                    unit: t.unit.clone(),
                    kind: if t.unit == "kcal" {
                        MeasureKind::Calories
                    } else {
                        MeasureKind::Nutrient(t.unit.clone())
                    },
                })
                .collect(),
            empty_ctx: IngredientCtx::new(Vec::new()),
            sub_totals: RefCell::new(HashMap::new()),
        }
    }

    pub fn recipe(&self, id: &str) -> Option<&'a WCostingRecipe> {
        self.recipes.get(id).copied()
    }

    fn ctx_for(&self, ingredient_id: &str) -> &IngredientCtx {
        self.ingredients
            .get(ingredient_id)
            .unwrap_or(&self.empty_ctx)
    }

    /// Convert one amount to every costing measure off a single graph — the old
    /// `conv_amount_all` + `measuresFromMappings` reshaping, inline. kcal rides
    /// the dedicated Calories conversion and is appended last (TS insertion
    /// order); per-target failures simply drop that nutrient.
    fn measures(&self, amounts: &[Measure], graph: &MeasureGraph) -> Trio {
        // Resolve every measure from ONE canonical amount, so a row's weight,
        // cost, and nutrients share a single basis (a row is one physical
        // quantity). Prefer a mass amount — the stated weight, resolved exactly
        // via the unit engine's mass identity — over a volume that needs a
        // density. Only fall back to another amount for a measure the canonical
        // one genuinely can't reach.
        let canonical = canonical_amount(amounts);
        let conv = |kind: MeasureKind| {
            canonical
                .and_then(|m| convert_measure_with_graph(m, kind.clone(), graph))
                .or_else(|| {
                    amounts
                        .iter()
                        .find_map(|m| convert_measure_with_graph(m, kind.clone(), graph))
                })
        };
        let money = conv(MeasureKind::Money);
        let weight = conv(MeasureKind::Weight);
        let calories = conv(MeasureKind::Calories);

        let mut entries: Vec<(String, f64)> = Vec::new();
        let mut kcal_code: Option<&str> = None;
        for t in &self.targets {
            match &t.kind {
                MeasureKind::Calories => kcal_code = Some(&t.code),
                kind => {
                    if let Some(c) = conv(kind.clone()) {
                        entries.push((t.code.clone(), c.value()));
                    }
                }
            }
        }
        if let (Some(code), Some(c)) = (kcal_code, &calories) {
            entries.push((code.to_string(), c.value()));
        }

        Trio {
            price: money
                .map(MeasureVal::from)
                .ok_or_else(|| "Error converting to money".to_string()),
            gram: weight
                .map(MeasureVal::from)
                .ok_or_else(|| "Error converting to weight".to_string()),
            nutrients: if entries.is_empty() {
                Err("No nutrient conversions succeeded".to_string())
            } else {
                Ok(entries)
            },
        }
    }

    /// The row's own-amount trio (the old `getIngredientMeasures`): sub-recipe
    /// rows roll up their own totals scaled by yield; ingredient rows convert
    /// through their product mappings.
    fn own_trio(&self, row: &WCostingRow, visited: &HashSet<String>, taint: &mut bool) -> Trio {
        if row.amounts.is_empty() {
            return Trio::all_err(format!("ingredient {} has no amounts", row.id));
        }
        let measures: Vec<Measure> = row.amounts.iter().map(|a| a.to_measure()).collect();
        match row.kind {
            WRowKind::Recipe => match self.sub_recipe_pairs(&row.target_id, visited, taint) {
                Some(pairs) => self.measures(&measures, &make_graph(&pairs)),
                None => Trio::all_err(format!("sub-recipe {} could not be costed", row.target_id)),
            },
            WRowKind::Ingredient => self.measures(&measures, self.ctx_for(&row.target_id).graph()),
        }
    }

    /// A sub-recipe's computed totals expressed as yield-relative mappings
    /// ("1 batch = $C = W g = N g protein = M kcal") — feeding the parent's
    /// amount through them yields the yield-scaled contribution. None when the
    /// sub-recipe wasn't provided, has no yield, or a cycle was detected
    /// (which also taints the enclosing computation against memoization).
    fn sub_recipe_pairs(
        &self,
        sub_id: &str,
        visited: &HashSet<String>,
        taint: &mut bool,
    ) -> Option<Vec<(Measure, Measure)>> {
        if visited.contains(sub_id) {
            // Cycle guard. The enclosing result now depends on the visited
            // set, not just recipe ids — never cache it.
            *taint = true;
            return None;
        }
        let sub = self.recipe(sub_id)?;
        let recipe_yield = sub.recipe_yield.as_ref()?;

        let cached = self.sub_totals.borrow().get(sub_id).cloned();
        let totals = match cached {
            Some(t) => t,
            None => {
                let mut v = visited.clone();
                v.insert(sub_id.to_string());
                let mut sub_taint = false;
                let out = self.cost_recipe_inner(sub, &v, false, &mut sub_taint);
                let t = SubTotals {
                    price: out.price,
                    weight: out.weight,
                    nutrients: out
                        .nutrients
                        .into_iter()
                        .map(|n| (n.code, n.value))
                        .collect(),
                };
                if sub_taint {
                    *taint = true;
                } else {
                    self.sub_totals
                        .borrow_mut()
                        .insert(sub_id.to_string(), t.clone());
                }
                t
            }
        };

        let yield_measure = recipe_yield.to_measure();
        let mut pairs = vec![
            (yield_measure.clone(), Measure::new("dollar", totals.price)),
            (yield_measure.clone(), Measure::new("g", totals.weight)),
        ];
        // One mapping per nutrient present in the sub totals, in target order
        // (the kcal target's unit is "kcal", matching the calories path).
        for t in &self.targets {
            if let Some((_, value)) = totals.nutrients.iter().find(|(code, _)| *code == t.code) {
                pairs.push((yield_measure.clone(), Measure::new(&t.unit, *value)));
            }
        }
        Some(pairs)
    }

    /// Measures for an estimated gram weight, converted through the
    /// ingredient's own mappings — calories, sodium, and (tiny) cost all come
    /// from the linked food with no hardcoded per-food constants. Errors when
    /// there's no estimable basis (renders as "—").
    fn estimated_trio(&self, grams: f64, row: &WCostingRow) -> Trio {
        if row.kind != WRowKind::Ingredient || grams <= 0.0 {
            return Trio::all_err("no basis for estimate");
        }
        self.measures(
            &[Measure::new("g", grams)],
            self.ctx_for(&row.target_id).graph(),
        )
    }

    /// Resolve a row's three measures per its plan. Returns the resolved trio
    /// plus the own trio when it was computed (own-gram feeds baker %).
    fn resolve_row(
        &self,
        row: &WCostingRow,
        plan: &PlanTrio,
        basis_grams: f64,
        visited: &HashSet<String>,
        taint: &mut bool,
    ) -> (Trio, Option<Trio>) {
        use ComponentSource::{BasisFraction, FlatGrams, Missing, OwnFraction, OwnFull};

        let needs_own = plan
            .sources()
            .iter()
            .any(|s| matches!(s, OwnFull | OwnFraction { .. }));
        let own = needs_own.then(|| self.own_trio(row, visited, taint));

        // One estimate trio per distinct gram value (in practice: one).
        // Keyed by the f64's bit pattern: the lookup re-derives the grams from
        // the same expression, so bitwise equality is exact.
        let mut est: Vec<(u64, Trio)> = Vec::new();
        for s in plan.sources() {
            let grams = match s {
                BasisFraction { fraction } => fraction * basis_grams,
                FlatGrams { grams } => grams,
                _ => continue,
            };
            if !est.iter().any(|(g, _)| *g == grams.to_bits()) {
                est.push((grams.to_bits(), self.estimated_trio(grams, row)));
            }
        }
        let est_for = |grams: f64| -> &Trio {
            &est.iter()
                .find(|(g, _)| *g == grams.to_bits())
                .expect("estimate precomputed for every estimate source")
                .1
        };
        let own_ref = || {
            own.as_ref()
                .expect("own trio precomputed for own-* sources")
        };
        let missing_err = || format!("ingredient {} has no amounts", row.id);

        let amount_for = |source: ComponentSource, pick: fn(&Trio) -> &MeasureRes| -> MeasureRes {
            match source {
                OwnFull => pick(own_ref()).clone(),
                OwnFraction { fraction } => scale_measure(pick(own_ref()), fraction),
                BasisFraction { fraction } => pick(est_for(fraction * basis_grams)).clone(),
                FlatGrams { grams } => pick(est_for(grams)).clone(),
                Missing => Err(missing_err()),
            }
        };
        let nutrients_for = |source: ComponentSource| -> NutrientsRes {
            match source {
                OwnFull => own_ref().nutrients.clone(),
                OwnFraction { fraction } => scale_nutrients(&own_ref().nutrients, fraction),
                BasisFraction { fraction } => est_for(fraction * basis_grams).nutrients.clone(),
                FlatGrams { grams } => est_for(grams).nutrients.clone(),
                Missing => Err(missing_err()),
            }
        };

        let trio = Trio {
            price: amount_for(plan.cost, |t| &t.price),
            gram: amount_for(plan.weight, |t| &t.gram),
            nutrients: nutrients_for(plan.nutrients),
        };
        (trio, own)
    }

    /// Unit-graph routes for a root row's driving amount (explain mode): its
    /// own written amount, or the estimated grams the weight plan substituted.
    /// None when there's nothing to trace (recipe rows, no amount, no mappings).
    fn paths_for(
        &self,
        row: &WCostingRow,
        plan: &PlanTrio,
        basis_grams: Option<f64>,
    ) -> Option<WRowPaths> {
        if row.kind != WRowKind::Ingredient {
            return None;
        }
        let ctx = self.ctx_for(&row.target_id);
        if ctx.pairs.is_empty() {
            return None;
        }
        let graph = ctx.graph();
        let measures: Vec<Measure> = row.amounts.iter().map(|a| a.to_measure()).collect();
        // The estimated-grams stand-in for amount-less rows (frying oil, to-taste).
        let estimated = match plan.weight {
            ComponentSource::BasisFraction { fraction } => {
                basis_grams.map(|b| Measure::new("g", fraction * b))
            }
            ComponentSource::FlatGrams { grams } => Some(Measure::new("g", grams)),
            _ => None,
        };
        // Trace the canonical amount the measure resolution drives off (mass
        // amount preferred), or the estimated grams when the row has none.
        let measure = canonical_amount(&measures).cloned().or(estimated)?;
        let explain = |kind: MeasureKind| {
            convert_measure_with_graph_explained(&measure, kind, graph)
                .map(|(_, steps)| steps.into_iter().map(WConversionStep::from).collect())
        };
        Some(WRowPaths {
            money: explain(MeasureKind::Money),
            weight: explain(MeasureKind::Weight),
            calories: explain(MeasureKind::Calories),
        })
    }

    /// Two-pass totals for one recipe (the old `calculateTotals`): pass 1
    /// resolves own-amount rows and accumulates the basis weight from own-full
    /// rows only — a deferred row (incl. a MEASURED frying medium, whose
    /// written amount is the pot volume) never feeds the basis, so pass 2 is
    /// order-independent.
    pub fn cost_recipe(
        &self,
        recipe: &WCostingRecipe,
        visited: &HashSet<String>,
        explain: bool,
    ) -> WRecipeCosting {
        let mut taint = false;
        self.cost_recipe_inner(recipe, visited, explain, &mut taint)
    }

    /// `cost_recipe` with cycle-taint propagation (`taint` flips to true when
    /// any descendant lookup hit the cycle guard — see `sub_totals`).
    fn cost_recipe_inner(
        &self,
        recipe: &WCostingRecipe,
        visited: &HashSet<String>,
        explain: bool,
        taint: &mut bool,
    ) -> WRecipeCosting {
        let planned = classify_planned_rows(recipe);

        let mut total_price = 0.0_f64;
        let mut total_weight = 0.0_f64;
        let mut total_nutrients: Vec<(String, f64)> = Vec::new();
        let mut missing = WMissingByType {
            price: Vec::new(),
            weight: Vec::new(),
            nutrients: Vec::new(),
        };

        // Collect a trio into the running totals, routing failures to
        // missingByType (display names, in resolution order).
        let mut fold = |trio: &Trio, name: &str| {
            match &trio.price {
                Ok(v) => total_price += v.value,
                Err(_) => missing.price.push(name.to_string()),
            }
            match &trio.gram {
                Ok(v) => total_weight += v.value,
                Err(_) => missing.weight.push(name.to_string()),
            }
            match &trio.nutrients {
                Ok(entries) => {
                    for (code, v) in entries {
                        match total_nutrients.iter_mut().find(|(c, _)| c == code) {
                            Some((_, acc)) => *acc += v,
                            None => total_nutrients.push((code.clone(), *v)),
                        }
                    }
                }
                Err(_) => missing.nutrients.push(name.to_string()),
            }
        };

        /// (resolved trio, own trio if computed, basis the row drew from).
        type RowOutcome = (Trio, Option<Trio>, Option<f64>);
        let n = planned.len();
        let mut outcomes: Vec<Option<RowOutcome>> = (0..n).map(|_| None).collect();

        // Pass 1: rows whose measures resolve from their own amounts.
        let mut basis_grams = 0.0_f64;
        let mut deferred: Vec<usize> = Vec::new();
        for (idx, p) in planned.iter().enumerate() {
            if p.plan.is_deferred() {
                deferred.push(idx);
                continue;
            }
            let (trio, own) = self.resolve_row(p.row, &p.plan, 0.0, visited, taint);
            fold(&trio, &p.row.name);
            if p.plan.contributes_to_basis() {
                if let Ok(g) = &trio.gram {
                    basis_grams += g.value;
                }
            }
            outcomes[idx] = Some((trio, own, None));
        }

        // Pass 2: basis-dependent and flat estimates, now that the basis is known.
        for idx in deferred {
            let p = &planned[idx];
            let (trio, own) = self.resolve_row(p.row, &p.plan, basis_grams, visited, taint);
            fold(&trio, &p.row.name);
            outcomes[idx] = Some((trio, own, Some(basis_grams)));
        }

        // Per-row output, in input order. own_gram (pre-estimate) feeds baker %.
        let mut own_grams: Vec<Option<f64>> = Vec::with_capacity(n);
        let mut flour_grams = 0.0_f64;
        let mut rows_out: Vec<WRowResult> = Vec::with_capacity(n);
        for (idx, p) in planned.iter().enumerate() {
            let (trio, own, basis) = outcomes[idx]
                .take()
                .expect("every row resolved in pass 1 or pass 2");
            let own_gram = own
                .as_ref()
                .and_then(|o| o.gram.as_ref().ok().map(|g| g.value));
            if p.row.is_flour {
                if let Some(g) = own_gram {
                    flour_grams += g;
                }
            }
            own_grams.push(own_gram);

            rows_out.push(WRowResult {
                id: p.row.id.clone(),
                name: p.row.name.clone(),
                section_name: p.row.section_name.clone(),
                kind: p.row.kind,
                usage: p.usage.into(),
                measured: !p.row.amounts.is_empty(),
                plan: p.plan,
                basis_grams: basis,
                price: to_measure_result(&trio.price),
                gram: to_measure_result(&trio.gram),
                nutrients: to_nutrients_result(&trio.nutrients),
                own_gram,
                estimated: p.plan.is_estimated(),
                paths: if explain {
                    self.paths_for(p.row, &p.plan, basis)
                } else {
                    None
                },
            });
        }

        // Baker's percentage: own grams ÷ total flour grams (flour = 100%).
        let baker_percentages = planned
            .iter()
            .zip(&own_grams)
            .map(|(p, og)| WBakerPct {
                row_id: p.row.id.clone(),
                pct: match (flour_grams > 0.0, og) {
                    (true, Some(g)) => Some(g / flour_grams * 100.0),
                    _ => None,
                },
            })
            .collect();

        WRecipeCosting {
            recipe_id: recipe.id.clone(),
            price: total_price,
            weight: total_weight,
            nutrients: total_nutrients
                .into_iter()
                .map(|(code, value)| WNutrientAmount { code, value })
                .collect(),
            total_ingredients: n as u32,
            missing_by_type: missing,
            rows: rows_out,
            baker_percentages,
        }
    }
}
