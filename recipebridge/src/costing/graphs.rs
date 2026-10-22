//! Ingredient-level conversion without conflating products' package counts.

use std::cell::OnceCell;
use std::collections::HashSet;

use ingredient::unit::{
    ConversionStep, Measure, MeasureGraph, MeasureKind, canonical_amount,
    convert_measure_with_graph_explained, make_graph,
};

use crate::food_mappings::{ProductPairs, WProductInput, product_non_price_mapping_pairs};

pub(super) struct ResolvedConversion {
    pub measure: Measure,
    pub steps: Vec<ConversionStep>,
}

/// Keep the selected conversion and its route together, including canonical fallback.
fn resolve_with_fallback(
    amounts: &[Measure],
    mut convert: impl FnMut(&Measure) -> Option<ResolvedConversion>,
) -> Option<ResolvedConversion> {
    canonical_amount(amounts)
        .and_then(&mut convert)
        .or_else(|| amounts.iter().find_map(convert))
}

pub(super) fn resolve_on_graph(
    amounts: &[Measure],
    graph: &MeasureGraph,
    target: MeasureKind,
) -> Option<ResolvedConversion> {
    resolve_with_fallback(amounts, |amount| convert(amount, graph, target.clone()))
}

fn convert(
    amount: &Measure,
    graph: &MeasureGraph,
    target: MeasureKind,
) -> Option<ResolvedConversion> {
    let (measure, steps) = convert_measure_with_graph_explained(amount, target, graph)?;
    Some(ResolvedConversion { measure, steps })
}

struct PackageGraph {
    pairs: Vec<(Measure, Measure)>,
    graph: OnceCell<MeasureGraph>,
}

pub(crate) struct AmbiguousPackage;

/// Density, food, and nutrient edges are shared. A route may use the package
/// edges of one product at a time. When a need has no product identity, all
/// reachable package interpretations must agree before it is a known quantity.
pub(crate) struct ProductGraphs {
    shared_pairs: Vec<(Measure, Measure)>,
    shared_graph: OnceCell<MeasureGraph>,
    products: Vec<PackageGraph>,
    pub(super) inferred_units: HashSet<String>,
}

fn nutrient_units(pair: &(Measure, Measure)) -> impl Iterator<Item = String> + '_ {
    [&pair.0, &pair.1]
        .into_iter()
        .filter(|measure| {
            matches!(
                measure.kind(),
                MeasureKind::Nutrient(_) | MeasureKind::Calories
            )
        })
        .map(|measure| measure.unit().to_str().into_owned())
}

impl ProductGraphs {
    pub fn new<'a>(products: impl IntoIterator<Item = &'a WProductInput>) -> Self {
        let mut shared_pairs = Vec::new();
        let mut inferred_pairs = Vec::new();
        let products = products
            .into_iter()
            .map(|product| {
                let ProductPairs {
                    package,
                    shared,
                    inferred,
                } = product_non_price_mapping_pairs(product);
                shared_pairs.extend(shared);
                inferred_pairs.extend(inferred);
                PackageGraph {
                    pairs: package,
                    graph: OnceCell::new(),
                }
            })
            .collect();
        let measured_units: HashSet<String> =
            shared_pairs.iter().flat_map(nutrient_units).collect();
        inferred_pairs
            .retain(|pair| !nutrient_units(pair).any(|unit| measured_units.contains(&unit)));
        let inferred_units = inferred_pairs.iter().flat_map(nutrient_units).collect();
        shared_pairs.splice(0..0, inferred_pairs);
        Self {
            shared_pairs,
            shared_graph: OnceCell::new(),
            products,
            inferred_units,
        }
    }

    pub fn has_mappings(&self) -> bool {
        !self.shared_pairs.is_empty()
            || self
                .products
                .iter()
                .any(|product| !product.pairs.is_empty())
    }

    fn shared_graph(&self) -> &MeasureGraph {
        self.shared_graph
            .get_or_init(|| make_graph(&self.shared_pairs))
    }

    fn product_graph(&self, index: usize) -> Option<&MeasureGraph> {
        let product = self.products.get(index)?;
        if product.pairs.is_empty() {
            return Some(self.shared_graph());
        }
        Some(product.graph.get_or_init(|| {
            let pairs: Vec<_> = self
                .shared_pairs
                .iter()
                .chain(&product.pairs)
                .cloned()
                .collect();
            make_graph(&pairs)
        }))
    }

    /// Resolve the canonical amount first across all eligible graphs, then try
    /// the other authored amounts. A shared route needs no package assumption.
    pub(super) fn resolve(
        &self,
        amounts: &[Measure],
        target: MeasureKind,
    ) -> Option<ResolvedConversion> {
        resolve_with_fallback(amounts, |amount| {
            self.resolve_amount(amount, target.clone()).ok().flatten()
        })
    }

    fn resolve_amount(
        &self,
        amount: &Measure,
        target: MeasureKind,
    ) -> Result<Option<ResolvedConversion>, AmbiguousPackage> {
        if let Some(resolved) = convert(amount, self.shared_graph(), target.clone()) {
            return Ok(Some(resolved));
        }
        let mut selected: Option<ResolvedConversion> = None;
        for (index, product) in self.products.iter().enumerate() {
            if product.pairs.is_empty() {
                continue;
            }
            let Some(graph) = self.product_graph(index) else {
                continue;
            };
            if let Some(candidate) = convert(amount, graph, target.clone()) {
                // The unit engine has rounded both results to public precision.
                if selected
                    .as_ref()
                    .is_some_and(|chosen| chosen.measure != candidate.measure)
                {
                    return Err(AmbiguousPackage);
                }
                selected = Some(candidate);
            }
        }
        Ok(selected)
    }

    /// Distinguish absent mappings from conflicting package interpretations so
    /// availability can retain authored-unit fallback only for absent routes.
    pub fn weight(&self, amount: &Measure) -> Result<Option<Measure>, AmbiguousPackage> {
        self.resolve_amount(amount, MeasureKind::Weight)
            .map(|value| value.map(|resolved| resolved.measure))
    }

    /// Inventory has a known product identity, while shared density and food
    /// mappings can still complete its own package route.
    pub fn product_weight(&self, index: usize, amount: &Measure) -> Option<Measure> {
        convert(amount, self.product_graph(index)?, MeasureKind::Weight).map(|value| value.measure)
    }

    /// A price-only product may borrow an unambiguous sibling package; a
    /// product declaring a package must resolve through that package itself.
    pub(super) fn priced_each(
        &self,
        index: usize,
        amounts: &[Measure],
    ) -> Option<ResolvedConversion> {
        let target = MeasureKind::Other("each".to_string());
        if self.products.get(index)?.pairs.is_empty() {
            self.resolve(amounts, target)
        } else {
            resolve_on_graph(amounts, self.product_graph(index)?, target)
        }
    }
}
