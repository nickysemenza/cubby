//! Unit-conversion exports: kind conversion, explained paths, and island/bridge
//! detection for the unit-mapping graph.

use std::{
    collections::{HashMap, HashSet},
    str::FromStr,
};

use ingredient::unit::{
    ConversionStep, Measure, MeasureKind, Unit, convert_measure_with_graph_explained,
    find_connected_components, is_valid, make_graph,
};
use serde::{Deserialize, Serialize};
use tsify_next::Tsify;
use wasm_bindgen::prelude::*;

use crate::{WAmount, WUnitMappings, from_js, to_js};

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

/// The built-in "native" bridge edges the unit-graph viz should draw, as
/// `[unitA, unitB]` pairs in the caller's ORIGINAL unit strings. `transparent` →
/// `type WUnitBridges = [string, string][]`.
#[derive(Tsify, Serialize, Deserialize)]
#[tsify(into_wasm_abi)]
#[serde(transparent)]
pub struct WUnitBridges(pub Vec<(String, String)>);

/// Compute the native bridge edges for the unit-mapping graph viz.
///
/// The viz draws stored mappings as solid edges; the engine additionally knows
/// built-in same-dimension conversions (cup↔tbsp) and strips portion modifiers
/// ("tbsp, drained" ↔ cup), so two units the stored edges leave in separate
/// pieces can still be convertible. Without a bridge those pieces float apart in
/// the layout even though `conversionCoverage` reports them connected.
///
/// Why this lives in Rust: `find_connected_components` names nodes by their
/// *normalized* unit (cup→tsp, $→cent), which the TS client can't map back to its
/// display units. We resolve component membership here — where the normalization
/// lives — by attaching a unique sentinel leaf to each original unit and reading
/// back which component the sentinel lands in.
///
/// Returns the *minimal* set of edges: for each engine component the stored edges
/// split across more than one piece, one edge per extra piece (preferring a
/// same-kind endpoint pair so the bridge reads as a real conversion). A
/// genuinely-disconnected unit — its own island — gets no edge.
#[wasm_bindgen]
pub fn unit_graph_bridges(mappings: WUnitMappings) -> WUnitBridges {
    // Distinct original units in first-seen order (stable bridge endpoints).
    let mut units: Vec<String> = Vec::new();
    let mut seen: HashSet<&str> = HashSet::new();
    for m in &mappings.0 {
        for u in [m.a.unit.as_str(), m.b.unit.as_str()] {
            if seen.insert(u) {
                units.push(u.to_string());
            }
        }
    }
    let index_of: HashMap<&str, usize> = units
        .iter()
        .enumerate()
        .map(|(i, u)| (u.as_str(), i))
        .collect();

    // Engine component membership per original unit. find_connected_components
    // names nodes by their normalized unit, so attach a unique sentinel leaf to
    // each original unit and read back which component the sentinel lands in.
    let sentinel = |i: usize| format!("cubbygraphnode{i}");
    let mut graph_pairs = mappings.to_pairs();
    for (i, u) in units.iter().enumerate() {
        graph_pairs.push((Measure::new(u, 1.0), Measure::new(&sentinel(i), 1.0)));
    }
    let components = find_connected_components(&make_graph(&graph_pairs));
    let mut engine_comp = vec![usize::MAX; units.len()];
    for (ci, group) in components.iter().enumerate() {
        for name in group {
            // Sentinels are lowercase/singular already, so they survive
            // normalization unchanged and map straight back to their unit index.
            if let Some(rest) = name.strip_prefix("cubbygraphnode")
                && let Ok(i) = rest.parse::<usize>()
                && i < units.len()
            {
                engine_comp[i] = ci;
            }
        }
    }

    // Union-find over original units, seeded with the stored (explicit) edges.
    let mut parent: Vec<usize> = (0..units.len()).collect();
    fn find(parent: &mut [usize], x: usize) -> usize {
        let mut root = x;
        while parent[root] != root {
            root = parent[root];
        }
        let mut cur = x;
        while parent[cur] != root {
            let next = parent[cur];
            parent[cur] = root;
            cur = next;
        }
        root
    }
    let union = |parent: &mut Vec<usize>, a: usize, b: usize| {
        let ra = find(parent, a);
        let rb = find(parent, b);
        if ra != rb {
            parent[ra] = rb;
        }
    };
    for m in &mappings.0 {
        if let (Some(&a), Some(&b)) = (
            index_of.get(m.a.unit.as_str()),
            index_of.get(m.b.unit.as_str()),
        ) {
            union(&mut parent, a, b);
        }
    }

    let kind_of = |i: usize| -> String {
        Unit::from_str(&units[i])
            .unwrap_or_else(|()| Unit::Other(units[i].clone()))
            .kind()
            .to_str()
            .into_owned()
    };

    // For each engine component, group its units by their current explicit piece;
    // if a component spans 2+ pieces, bridge them (anchor piece → each other).
    let mut by_engine: HashMap<usize, Vec<usize>> = HashMap::new();
    for (i, &c) in engine_comp.iter().enumerate() {
        if c != usize::MAX {
            by_engine.entry(c).or_default().push(i);
        }
    }
    let mut bridges: Vec<(String, String)> = Vec::new();
    for members in by_engine.values() {
        // Group members by explicit-piece root, preserving first-seen order.
        let mut pieces: Vec<Vec<usize>> = Vec::new();
        let mut piece_of_root: HashMap<usize, usize> = HashMap::new();
        for &m in members {
            let root = find(&mut parent, m);
            let pi = *piece_of_root.entry(root).or_insert_with(|| {
                pieces.push(Vec::new());
                pieces.len() - 1
            });
            pieces[pi].push(m);
        }
        if pieces.len() < 2 {
            continue;
        }
        let anchor = pieces[0].clone();
        for piece in &pieces[1..] {
            let (a, b) = pick_endpoints(&anchor, piece, &kind_of);
            bridges.push((units[a].clone(), units[b].clone()));
            union(&mut parent, a, b);
        }
    }
    WUnitBridges(bridges)
}

/// Prefer a same-kind (u, v) endpoint pair across two pieces so the dashed bridge
/// reads as a real built-in conversion; fall back to the first of each.
fn pick_endpoints(a: &[usize], b: &[usize], kind_of: &impl Fn(usize) -> String) -> (usize, usize) {
    for &u in a {
        for &v in b {
            if kind_of(u) == kind_of(v) {
                return (u, v);
            }
        }
    }
    (a[0], b[0])
}

/// The native core of `conv_amount_to_kind`: everything after the JsValue
/// `target_kind` is deserialized to `kind_str`, so the from_str + convert + error
/// logic is exercised under `cargo test` without a wasm runtime.
///
/// `from_str` is currently infallible (an unknown kind becomes `other:<s>`), so
/// the `map_err` is dead today — but keep it: it returns an error rather than
/// panicking if upstream ever makes the parse fallible. `measure_kind_from_str_contract`
/// pins the current behavior and would flag that change.
fn conv_to_kind_core(
    pairs: &[(Measure, Measure)],
    kind_str: &str,
    measure: &Measure,
) -> Result<WAmount, String> {
    let kind =
        MeasureKind::from_str(kind_str).map_err(|_| format!("Invalid amount kind: {kind_str}"))?;
    measure
        .convert_measure_via_mappings(kind.clone(), pairs)
        .ok_or_else(|| format!("Failed to convert '{measure}' to '{kind}'"))
        .map(WAmount::from)
}

#[wasm_bindgen]
pub fn conv_amount_to_kind(
    mappings: WUnitMappings,
    target_kind_w: WAmountKind,
    amount_w: WAmount,
) -> Result<WAmount, String> {
    let kind_str: String = from_js(target_kind_w, "amount kind")?;
    conv_to_kind_core(&mappings.to_pairs(), &kind_str, &amount_w.to_measure())
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

// ---------------------------------------------------------------------------
// Golden tests — drift tripwires for the ingredient crate's unit-conversion
// surface (pinned by exact git rev). `detect_unit_mapping_islands` and
// `is_valid_unit` take native types and run
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
        Measure, MeasureKind, convert_measure_with_graph_explained, make_graph,
    };
    use rstest::rstest;
    use std::collections::HashSet;
    use std::str::FromStr;

    use crate::WUnitMapping;

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
        assert!(
            islands.iter().any(|g| {
                g.contains(&"widget".to_string()) && g.contains(&"gadget".to_string())
            })
        );
    }

    /// A bridge edge set as unordered `{a|b}` keys, so assertions don't depend on
    /// which endpoint the algorithm picked as `a` vs `b`.
    fn bridge_keys(b: WUnitBridges) -> HashSet<String> {
        b.0.into_iter()
            .map(|(a, b)| {
                let mut pair = [a, b];
                pair.sort();
                pair.join("|")
            })
            .collect()
    }

    /// The islanded-price bug: food edges (g↔kcal, g↔"tbsp, drained"), a cup price
    /// (cup↔$), and a drained→tbsp conversion. The engine connects cup into the
    /// food cluster via a built-in volume edge, but the stored edges leave cup/$ a
    /// separate piece — so one bridge is emitted, preferring the volume pair
    /// cup↔tbsp over an arbitrary cross-kind one.
    #[test]
    fn bridges_reconnect_islanded_price() {
        let mappings = WUnitMappings(vec![
            mapping(100.0, "g", 387.0, "kcal"),
            mapping(1.0, "g", 0.0667, "tbsp, drained"),
            mapping(1.0, "cup", 5.0, "dollar"),
            mapping(1.0, "tbsp, drained", 1.0, "tbsp"),
        ]);
        let keys = bridge_keys(unit_graph_bridges(mappings));
        assert_eq!(keys, HashSet::from(["cup|tbsp".to_string()]));
    }

    /// The gallery fixture analog: a cup→g density edge and an lb price. lb is
    /// connected to the cluster only through the built-in weight family, so the
    /// bridge is the weight pair g↔lb.
    #[test]
    fn bridges_reconnect_weight_priced_unit() {
        let mappings = WUnitMappings(vec![
            mapping(1.0, "cup", 120.0, "g"),
            mapping(2.0, "lb", 5.0, "dollar"),
        ]);
        let keys = bridge_keys(unit_graph_bridges(mappings));
        assert_eq!(keys, HashSet::from(["g|lb".to_string()]));
    }

    /// Genuinely-disconnected units (no built-in conversion bridges them) get no
    /// edge — the fix must not over-connect a real island.
    #[test]
    fn bridges_leave_true_islands_separate() {
        let mappings = WUnitMappings(vec![
            mapping(1.0, "cup", 120.0, "g"),
            mapping(1.0, "widget", 3.0, "gadget"),
        ]);
        assert!(bridge_keys(unit_graph_bridges(mappings)).is_empty());
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

    /// `conv_amount_to_kind`'s own logic (from_str + convert + the documented-dead
    /// error branch), exercised natively via the extracted core: a reachable kind
    /// converts; an unreachable one returns the public fn's error (not a panic).
    #[test]
    fn conv_to_kind_core_converts_and_errors() {
        let pairs = WUnitMappings(vec![mapping(1.0, "cup", 120.0, "g")]).to_pairs();
        let ok = conv_to_kind_core(&pairs, "weight", &Measure::new("cup", 2.0)).expect("cup→g");
        assert_eq!((ok.unit.as_str(), ok.value), ("g", 240.0));
        // No volume→money edge → the public fn's error path.
        assert!(conv_to_kind_core(&pairs, "money", &Measure::new("cup", 2.0)).is_err());
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
        assert!(
            convert_measure_with_graph_explained(
                &Measure::new("cup", 2.0),
                MeasureKind::Money,
                &graph,
            )
            .is_none()
        );
    }
}
