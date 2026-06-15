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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[tsify(optional)]
    pub result: Option<WAmount>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[tsify(optional)]
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

/// Disconnected components (islands) of a unit-mapping graph: a list of groups,
/// each a list of unit strings. `transparent` → `type WUnitIslands = string[][]`.
#[derive(Tsify, Serialize, Deserialize)]
#[tsify(into_wasm_abi)]
#[serde(transparent)]
pub struct WUnitIslands(pub Vec<Vec<String>>);

/// Detect disconnected components (islands) in the unit-mapping graph. Infallible
/// — `find_connected_components` always returns (an empty list when the graph is
/// fully connected or has <2 nodes).
#[wasm_bindgen]
pub fn detect_unit_mapping_islands(mappings: WUnitMappings) -> WUnitIslands {
    WUnitIslands(find_connected_components(&make_graph(&mappings.to_pairs())))
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
    // `from_str` is currently infallible (an unknown kind becomes `other:<s>`), so
    // this map_err is dead today — but keep it: it returns an error rather than
    // panicking if upstream ever makes the parse fallible. `measure_kind_from_str_contract`
    // pins the current behavior and would flag that change.
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
    // Defensive map_err — see conv_amount_to_kind: `from_str` is infallible today.
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
    let kind = amount.to_measure().kind();
    to_js(&kind.to_str(), "amount kind").map(Into::into)
}

/// Parse a unit mapping string in multiple formats:
/// - "4 lb = $5" (conversion format)
/// - "$5/4lb" (price-per format)
/// - "4 lb = $5 @ costco" (with source)
#[wasm_bindgen]
pub fn parse_unit_mapping(input: String) -> Result<WUnitMapping, String> {
    Ok(parse_unit_mapping_internal(&input)?.into())
}

// ---------------------------------------------------------------------------
// Golden tests — drift tripwires for the ingredient crate's unit-conversion
// surface (pinned by exact git rev). `parse_unit_mapping`,
// `detect_unit_mapping_islands`, and `is_valid_unit` take native types and run
// directly. `amount_kind` / `conv_amount_*` round-trip through `WAmountKind` (a
// JsValue extern type) and so can't run natively — instead we pin the upstream
// engine they wrap (`Measure::kind`, `MeasureKind::from_str`,
// `convert_measure_with_graph_explained`), which is the actual drift surface.
// Complementary to the food_mappings.rs graph tests, not duplicative.
// ---------------------------------------------------------------------------
#[cfg(test)]
mod tests {
    use super::*;
    use ingredient::unit::{
        convert_measure_with_graph_explained, make_graph, Measure, MeasureKind,
    };
    use rstest::rstest;
    use std::str::FromStr;

    fn amt(value: f64, unit: &str) -> WAmount {
        WAmount {
            unit: unit.to_string(),
            value,
            upper_value: None,
        }
    }
    fn mapping(av: f64, au: &str, bv: f64, bu: &str) -> WUnitMapping {
        WUnitMapping {
            a: amt(av, au),
            b: amt(bv, bu),
            source: None,
            source_metadata: None,
        }
    }

    /// The three documented `parse_unit_mapping` input formats normalize to the
    /// same `a`/`b` amounts (money unit is `$`); only the `@ source` form
    /// populates `source`.
    #[rstest]
    #[case("4 lb = $5", None)]
    #[case("$5/4lb", None)]
    #[case("4 lb = $5 @ costco", Some("costco"))]
    fn parse_unit_mapping_formats(#[case] input: &str, #[case] source: Option<&str>) {
        let m = parse_unit_mapping(input.to_string()).expect("parses");
        assert_eq!((m.a.value, m.a.unit.as_str()), (4.0, "lb"));
        assert_eq!((m.b.value, m.b.unit.as_str()), (5.0, "$"));
        assert_eq!(m.source.as_deref(), source);
    }

    /// A graph whose edges all reach the standard unit graph is one component, so
    /// no product is flagged (problems.ts gates on `len >= 2`): cup→g joins the
    /// volume/weight graph and g→$ extends it.
    #[test]
    fn islands_connected_graph_is_one_component() {
        let connected = WUnitMappings(vec![
            mapping(1.0, "cup", 120.0, "g"),
            mapping(100.0, "g", 2.0, "dollar"),
        ]);
        assert_eq!(detect_unit_mapping_islands(connected).0.len(), 1);
    }

    /// Custom units unreachable from the standard graph island off into their own
    /// group — the disconnected shape problems.ts flags.
    #[test]
    fn islands_disconnected_units_form_separate_groups() {
        let two = WUnitMappings(vec![
            mapping(1.0, "cup", 120.0, "g"),
            mapping(1.0, "widget", 3.0, "gadget"),
        ]);
        let islands = detect_unit_mapping_islands(two).0;
        assert_eq!(islands.len(), 2);
        assert!(islands
            .iter()
            .any(|g| { g.contains(&"widget".to_string()) && g.contains(&"gadget".to_string()) }));
    }

    /// `is_valid_unit`: a known unit is valid, a bogus one isn't, and one supplied
    /// only via `extra_units` becomes valid.
    #[test]
    fn is_valid_unit_known_bogus_and_extra() {
        assert!(is_valid_unit("g", vec![]));
        assert!(!is_valid_unit("zzzq", vec![]));
        assert!(is_valid_unit("zzzq", vec!["zzzq".to_string()]));
    }

    /// `amount_kind`'s underlying logic — `Measure::kind()` → `MeasureKind::to_str()`.
    /// Note an unknown unit does NOT error: it classifies as `other:<unit>` (so the
    /// public fn has no error path for unknown units), and per-nutrient units map
    /// to the `nutrient:*` template the AmountKind union carries.
    #[rstest]
    #[case("g", "weight")]
    #[case("cup", "volume")]
    #[case("dollar", "money")]
    #[case("kcal", "calories")]
    #[case("min", "time")]
    #[case("g protein", "nutrient:g protein")]
    #[case("bogusunit", "other:bogusunit")]
    fn amount_kind_classification(#[case] unit: &str, #[case] expected: &str) {
        let kind = amt(1.0, unit).to_measure().kind();
        assert_eq!(&*kind.to_str(), expected);
    }

    /// The kind-string contract `conv_amount_to_kind` / `conv_amount_explain`
    /// depend on (via `MeasureKind::from_str`). NB it's infallible: a known kind
    /// round-trips and an unknown string falls back to `other:<s>` rather than
    /// erroring — so the public fns' `.map_err("Invalid amount kind")` branch is
    /// effectively unreachable. Pinning this means a future upstream change that
    /// makes `from_str` reject unknowns (re-arming that branch) is noticed here.
    #[test]
    fn measure_kind_from_str_contract() {
        assert_eq!(MeasureKind::from_str("weight").unwrap().to_str(), "weight");
        assert_eq!(
            MeasureKind::from_str("not-a-kind").unwrap().to_str(),
            "other:not-a-kind"
        );
    }

    /// `conv_amount_explain`'s happy path: the engine it wraps converts 2 cup → g
    /// and returns a non-empty step path.
    #[test]
    fn conv_explain_happy_path() {
        let graph = make_graph(&WUnitMappings(vec![mapping(1.0, "cup", 120.0, "g")]).to_pairs());
        let (m, steps) = convert_measure_with_graph_explained(
            &Measure::new("cup", 2.0),
            MeasureKind::Weight,
            &graph,
        )
        .expect("cup→g path");
        assert_eq!(m.value(), 240.0);
        assert_eq!(&*m.unit().to_str(), "g");
        assert!(!steps.is_empty());
    }

    /// The no-path case: no edge bridges volume to money, so the engine returns
    /// `None` (the public fn's `{result: None, path: None}`).
    #[test]
    fn conv_explain_no_path_is_none() {
        let graph = make_graph(&WUnitMappings(vec![mapping(1.0, "cup", 120.0, "g")]).to_pairs());
        assert!(convert_measure_with_graph_explained(
            &Measure::new("cup", 2.0),
            MeasureKind::Money,
            &graph,
        )
        .is_none());
    }
}
