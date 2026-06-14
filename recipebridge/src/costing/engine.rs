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
//!
//! Known limitation — multiple *priced* products on one ingredient (dormant):
//! all of an ingredient's products are merged into one graph (see `Engine::new`),
//! which is load-bearing — products complete each other's edges. The hazard is
//! only the synthesized `1 each = $price` edge: with ≥2 priced products their
//! `each → dollar` edges collide and conversion picks one arbitrarily. Intended
//! fix (NOT implemented): keep one shared conversion graph per ingredient from
//! all *non-price* edges, then resolve price *per priced product* (amount → `each`
//! on the shared graph, × that product's $/each) and take the **cheapest**; keep
//! weight/nutrition single-valued on the shared graph. Do *not* isolate whole
//! graphs per product — that breaks the cross-product completion.

use std::cell::{OnceCell, RefCell};
use std::collections::{HashMap, HashSet};

use ingredient::classify_usage;
use ingredient::unit::{
    convert_measure_with_graph_explained, make_graph, Measure, MeasureGraph, MeasureKind,
};
use ingredient::usage::IngredientUsage;

use super::consumption::{plan_for, ComponentSource, PlanTrio};
use super::types::{
    WBakerPct, WCostingInput, WCostingRecipe, WCostingRow, WMeasureOk, WMeasureResult,
    WMissingByType, WNutrientAmount, WNutrientsOk, WNutrientsResult, WRecipeCosting, WRowKind,
    WRowPaths, WRowResult,
};
use crate::reconcile::{canonical_amount, convert_with_fallback, pairs_for_product};
use crate::WConversionStep;

/// One recipe row paired with its resolved usage and the consumption plan that
/// usage implies. Built up front (before the two resolution passes) so each
/// pass reads a stable per-row plan.
struct Planned<'r> {
    row: &'r WCostingRow,
    usage: IngredientUsage,
    plan: PlanTrio,
    /// Whether this row is a flour (the baker's-percentage base), classified
    /// from the row name — see `is_flour`.
    is_flour: bool,
}

/// The flour that forms a baker's-percentage base. Substring "flour" catches
/// bread/AP/all-purpose/whole-wheat/white/cake/pastry/00/durum flour; a few
/// common flours-by-other-name are listed explicitly. (Port of the old TS
/// `isFlourIngredient` — owned here so the rule has one home.)
fn is_flour(name: &str) -> bool {
    let n = name.to_lowercase();
    n.contains("flour") || n.contains("semolina")
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
            Planned {
                row,
                usage,
                plan,
                is_flour: is_flour(&row.name),
            }
        })
        .collect()
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
/// Per-nutrient `(code, lower, upper)` — `upper` is `Some` only when the amount
/// resolved to a range (a ranged written amount, or a ranged sub-recipe rate).
type NutrientsRes = Result<Vec<(String, f64, Option<f64>)>, String>;

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
            .map(|(code, v, u)| (code.clone(), v * fraction, u.map(|x| x * fraction)))
            .collect()),
        Err(e) => Err(e.clone()),
    }
}

/// Build a measure carrying an optional range upper bound (the sub-recipe rate
/// edges and any ranged total). Collapses a degenerate/absent upper to a point.
fn measure_with_optional_upper(unit: &str, value: f64, upper: Option<f64>) -> Measure {
    match upper {
        Some(u) if u > value => Measure::with_range(unit, value, u),
        _ => Measure::new(unit, value),
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
                .map(|(code, value, upper)| WNutrientAmount {
                    code: code.clone(),
                    value: *value,
                    upper_value: *upper,
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

/// A costed sub-recipe's totals, the inputs to its yield mappings. Uppers are
/// `Some` only when the sub-recipe itself contains a ranged amount, in which
/// case the yield mapping edge becomes a range and the parent's conversion
/// rolls it up scaled (the unit graph multiplies the interval by the factor).
#[derive(Clone)]
struct SubTotals {
    price: f64,
    price_upper: Option<f64>,
    weight: f64,
    weight_upper: Option<f64>,
    nutrients: Vec<(String, f64, Option<f64>)>,
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
                    // Merge ALL products' mappings into one graph. This is
                    // intentional and load-bearing: products complete each other
                    // (e.g. branded "Pete & Gerry's" eggs has no mappings and
                    // reaches its price only via the generic shell's
                    // `large → whole → each` bridge; branded olive oil supplies
                    // price+package but its nutrition comes from the shell's USDA
                    // food). The flip side is the price-collision hazard noted in
                    // the module doc — multiple priced products on one ingredient
                    // collide on the shared `each` node → arbitrary pick. Dormant
                    // today (no ingredient has 2+ priced products).
                    let pairs = i.products.iter().flat_map(pairs_for_product).collect();
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
        let conv = |kind: MeasureKind| convert_with_fallback(amounts, graph, kind);
        let money = conv(MeasureKind::Money);
        let weight = conv(MeasureKind::Weight);
        let calories = conv(MeasureKind::Calories);

        let mut entries: Vec<(String, f64, Option<f64>)> = Vec::new();
        let mut kcal_code: Option<&str> = None;
        for t in &self.targets {
            match &t.kind {
                MeasureKind::Calories => kcal_code = Some(&t.code),
                kind => {
                    if let Some(c) = conv(kind.clone()) {
                        entries.push((t.code.clone(), c.value(), c.upper_value()));
                    }
                }
            }
        }
        if let (Some(code), Some(c)) = (kcal_code, &calories) {
            entries.push((code.to_string(), c.value(), c.upper_value()));
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
                    price_upper: out.price_upper,
                    weight: out.weight,
                    weight_upper: out.weight_upper,
                    nutrients: out
                        .nutrients
                        .into_iter()
                        .map(|n| (n.code, n.value, n.upper_value))
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
            (
                yield_measure.clone(),
                measure_with_optional_upper("dollar", totals.price, totals.price_upper),
            ),
            (
                yield_measure.clone(),
                measure_with_optional_upper("g", totals.weight, totals.weight_upper),
            ),
        ];
        // One mapping per nutrient present in the sub totals, in target order
        // (the kcal target's unit is "kcal", matching the calories path). A
        // ranged sub total makes the edge a range, which the parent conversion
        // scales and propagates.
        for t in &self.targets {
            if let Some((_, value, upper)) =
                totals.nutrients.iter().find(|(code, ..)| *code == t.code)
            {
                pairs.push((
                    yield_measure.clone(),
                    measure_with_optional_upper(&t.unit, *value, *upper),
                ));
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
        let mut total_price_upper = 0.0_f64;
        let mut any_price_upper = false;
        let mut total_weight = 0.0_f64;
        let mut total_weight_upper = 0.0_f64;
        let mut any_weight_upper = false;
        // (code, lower, upper, any_upper): the upper total sums (upper ?? lower)
        // so a partially-ranged recipe gives [Σlower, Σupper]; any_upper marks
        // whether any contributor was ranged (else the upper is dropped on output).
        let mut total_nutrients: Vec<(String, f64, f64, bool)> = Vec::new();
        let mut missing = WMissingByType {
            price: Vec::new(),
            weight: Vec::new(),
            nutrients: Vec::new(),
        };

        // Collect a trio into the running totals, routing failures to
        // missingByType (display names, in resolution order).
        let mut fold = |trio: &Trio, name: &str| {
            match &trio.price {
                Ok(v) => {
                    total_price += v.value;
                    total_price_upper += v.upper.unwrap_or(v.value);
                    any_price_upper |= v.upper.is_some();
                }
                Err(_) => missing.price.push(name.to_string()),
            }
            match &trio.gram {
                Ok(v) => {
                    total_weight += v.value;
                    total_weight_upper += v.upper.unwrap_or(v.value);
                    any_weight_upper |= v.upper.is_some();
                }
                Err(_) => missing.weight.push(name.to_string()),
            }
            match &trio.nutrients {
                Ok(entries) => {
                    for (code, lo, hi) in entries {
                        let upper = hi.unwrap_or(*lo);
                        match total_nutrients.iter_mut().find(|(c, ..)| c == code) {
                            Some((_, acc_lo, acc_hi, acc_any)) => {
                                *acc_lo += lo;
                                *acc_hi += upper;
                                *acc_any |= hi.is_some();
                            }
                            None => total_nutrients.push((code.clone(), *lo, upper, hi.is_some())),
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
            if p.is_flour {
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
                is_flour: p.is_flour,
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
            price_upper: any_price_upper.then_some(total_price_upper),
            weight: total_weight,
            weight_upper: any_weight_upper.then_some(total_weight_upper),
            nutrients: total_nutrients
                .into_iter()
                .map(|(code, value, upper, any)| WNutrientAmount {
                    code,
                    value,
                    upper_value: any.then_some(upper),
                })
                .collect(),
            total_ingredients: n as u32,
            missing_by_type: missing,
            rows: rows_out,
            baker_percentages,
        }
    }
}
