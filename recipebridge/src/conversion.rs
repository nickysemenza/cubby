//! Unit-conversion exports: kind conversion, explained paths, graph debugging,
//! and unit-mapping string parsing.

use std::{collections::HashSet, str::FromStr};

use ingredient::{
    unit::{
        convert_measure_with_graph_explained, find_connected_components, is_valid, make_graph,
        print_graph, ConversionStep, MeasureKind,
    },
    unit_mapping::{parse_unit_mapping as parse_unit_mapping_internal, ParsedUnitMapping},
};
use serde::{Deserialize, Serialize};
use tsify_next::Tsify;
use wasm_bindgen::prelude::*;

use crate::{from_js, to_js, WAmount, WUnitMapping, WUnitMappings};

/// One hop of an explained conversion path (mirrors `ConversionStep`). Units are
/// the normalized graph nodes (cup amounts enter at `tsp`, money at `cent`).
#[derive(Tsify, Serialize, Deserialize, Debug)]
#[tsify(into_wasm_abi)]
pub struct WConversionStep {
    pub from_unit: String,
    pub to_unit: String,
    pub factor: f64,
}

impl From<ConversionStep> for WConversionStep {
    fn from(s: ConversionStep) -> Self {
        Self {
            from_unit: s.from_unit.to_str().into_owned(),
            to_unit: s.to_unit.to_str().into_owned(),
            factor: s.factor,
        }
    }
}

/// An explained conversion: the converted amount plus the unit-graph path that
/// produced it (both null when no path exists). The conversion's "show your
/// work" — a bogus route (e.g. grams reaching money via a serving-count `whole`
/// edge) reads right off the steps.
#[derive(Tsify, Serialize, Deserialize)]
#[tsify(into_wasm_abi)]
pub struct WAmountExplained {
    pub result: Option<WAmount>,
    pub path: Option<Vec<WConversionStep>>,
}

// Hand-authored boundary type that can't be derived: `AmountKind`, a
// `nutrient:${string}` template-literal union.
#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(typescript_type = "AmountKind")]
    pub type WAmountKind;
}

#[wasm_bindgen(typescript_custom_section)]
const HAND_AUTHORED_TS: &str = r#"
type AmountKind = "weight" | "volume" | "money" | "calories" | "time" | "temperature" | "length" | "other" | `nutrient:${string}`;
"#;

impl From<ParsedUnitMapping> for WUnitMapping {
    fn from(p: ParsedUnitMapping) -> Self {
        Self {
            a: WAmount::from(&p.a),
            b: WAmount::from(&p.b),
            source: p.source,
            source_metadata: None,
        }
    }
}

#[wasm_bindgen]
pub fn graph_unit_mappings(mappings: WUnitMappings) -> String {
    print_graph(make_graph(&mappings.to_pairs()))
}

/// Detect disconnected components (islands) in the unit-mapping graph. Returns a
/// list of component groups, where each group is a list of unit strings.
#[wasm_bindgen]
pub fn detect_unit_mapping_islands(mappings: WUnitMappings) -> Result<JsValue, String> {
    let graph = make_graph(&mappings.to_pairs());
    let components = find_connected_components(&graph);
    to_js(&components, "connected components")
}

#[wasm_bindgen]
pub fn conv_amount_to_kind(
    mappings: WUnitMappings,
    target_kind_w: WAmountKind,
    amount_w: WAmount,
) -> Result<WAmount, String> {
    let pairs = mappings.to_pairs();
    let measure = amount_w.to_measure();
    let kind_str: String = from_js(target_kind_w, "amount kind")?;
    let kind =
        MeasureKind::from_str(&kind_str).map_err(|_| format!("Invalid amount kind: {kind_str}"))?;

    measure
        .convert_measure_via_mappings(kind.clone(), &pairs)
        .ok_or_else(|| format!("Failed to convert '{measure}' to '{kind}'"))
        .map(WAmount::from)
}

/// Convert an amount to a target kind AND return the conversion path traversed
/// (which unit-mapping edges, with their factors). Result/path are null when no
/// path exists. Powers the costing debug/explain surfaces.
#[wasm_bindgen]
pub fn conv_amount_explain(
    mappings: WUnitMappings,
    target_kind_w: WAmountKind,
    amount_w: WAmount,
) -> Result<WAmountExplained, String> {
    let measure = amount_w.to_measure();
    let kind_str: String = from_js(target_kind_w, "amount kind")?;
    let kind =
        MeasureKind::from_str(&kind_str).map_err(|_| format!("Invalid amount kind: {kind_str}"))?;
    let graph = make_graph(&mappings.to_pairs());

    Ok(
        match convert_measure_with_graph_explained(&measure, kind, &graph) {
            Some((m, steps)) => WAmountExplained {
                result: Some(m.into()),
                path: Some(steps.into_iter().map(WConversionStep::from).collect()),
            },
            None => WAmountExplained {
                result: None,
                path: None,
            },
        },
    )
}

#[wasm_bindgen]
pub fn is_valid_unit(unit: &str, extra_units: Vec<String>) -> bool {
    is_valid(&HashSet::from_iter(extra_units), unit)
}

#[wasm_bindgen]
pub fn amount_kind(amount: WAmount) -> Result<WAmountKind, String> {
    amount
        .to_measure()
        .kind()
        .map_err(|_| "Unknown unit kind".to_string())
        .and_then(|k| to_js(&k.to_str(), "amount kind").map(Into::into))
}

/// Parse a unit mapping string in multiple formats:
/// - "4 lb = $5" (conversion format)
/// - "$5/4lb" (price-per format)
/// - "4 lb = $5 @ costco" (with source)
#[wasm_bindgen]
pub fn parse_unit_mapping(input: String) -> Result<WUnitMapping, String> {
    Ok(parse_unit_mapping_internal(&input)?.into())
}
