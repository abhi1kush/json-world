//! Property tests: random documents survive round trips.
use converter::*;
use proptest::prelude::*;
use serde_json::{Map, Number, Value};

fn num() -> impl Strategy<Value = Value> {
    prop_oneof![
        any::<i64>().prop_map(|n| Value::Number(n.into())),
        (any::<i32>(), 0u32..1000).prop_map(|(a, b)| serde_json::from_str(&format!("{a}.{b}")).unwrap()),
        "[1-9][0-9]{18,30}".prop_map(|s| serde_json::from_str(&s).unwrap()),
        Just(serde_json::from_str("-0").unwrap()),
        Just(serde_json::from_str("1e-7").unwrap()),
    ]
}
fn any_string() -> impl Strategy<Value = String> {
    prop_oneof![
        "\\PC{0,12}",
        "[ -~]{0,12}",
        prop::sample::select(vec!["true", "null", "yes", "No", "~", "1", "-1.5", "0x10", ".inf", "", " ", "- a", "a: b", "#x", "'q'", "\"", "\\", "\n", "\t", "\u{85}", "\u{2028}", "\u{feff}", "é😀", "---", "...", "<<", "@", "a #b", "1e3"]).prop_map(String::from),
    ]
}
fn json_value() -> impl Strategy<Value = Value> {
    let leaf = prop_oneof![Just(Value::Null), any::<bool>().prop_map(Value::Bool), num(), any_string().prop_map(Value::String)];
    leaf.prop_recursive(4, 40, 6, |inner| prop_oneof![
        prop::collection::vec(inner.clone(), 0..5).prop_map(Value::Array),
        prop::collection::vec((any_string(), inner), 0..5).prop_map(|kv| Value::Object(kv.into_iter().collect::<Map<_, _>>())),
    ])
}

// XML-representable values under the convention: leaves are non-empty strings without
// leading/trailing whitespace or control chars (or, with inferTypes, numbers/bools whose
// strings never look like numbers/bools); arrays have >= 2 non-array items; objects have
// valid element names; null = empty element.
fn xml_text() -> impl Strategy<Value = String> { "[A-Za-z_<>&\"'é][A-Za-z0-9 _<>&\"'é.]{0,8}[A-Za-z_<>&é]".prop_map(|s| s) }
fn xml_name() -> impl Strategy<Value = String> { "[a-z][a-z0-9_.-]{0,6}" }
fn xml_value(typed: bool) -> impl Strategy<Value = Value> {
    let leaf = if typed {
        prop_oneof![Just(Value::Null), xml_text().prop_map(Value::String), any::<bool>().prop_map(Value::Bool), num().prop_filter("no -0", |n| n.to_string() != "-0")].boxed()
    } else {
        prop_oneof![Just(Value::Null), xml_text().prop_map(Value::String)].boxed()
    };
    leaf.prop_recursive(3, 30, 4, move |inner| {
        let child = inner.clone();
        prop_oneof![
            // element with children (+ optional attributes)
            (prop::collection::vec((xml_name(), prop_oneof![
                3 => child.clone(),
                1 => prop::collection::vec(child.clone(), 2..4).prop_map(Value::Array),
            ]), 1..4), prop::collection::vec((xml_name(), xml_text()), 0..2))
                .prop_map(|(kids, attrs)| {
                    let mut m = Map::new();
                    for (k, v) in attrs { m.insert(format!("@{k}"), Value::String(v)); }
                    for (k, v) in kids { m.insert(k, v); }
                    Value::Object(m)
                }),
            // element with attributes + text
            (prop::collection::vec((xml_name(), xml_text()), 1..3), xml_text()).prop_map(|(attrs, t)| {
                let mut m = Map::new();
                for (k, v) in attrs { m.insert(format!("@{k}"), Value::String(v)); }
                m.insert("#text".into(), Value::String(t));
                Value::Object(m)
            }),
        ]
    })
}
// arrays under a key must hold non-array items and every array item that is itself an
// object with no children... is fine. Filter out nested arrays defensively.
fn no_nested_arrays(v: &Value) -> bool {
    match v {
        Value::Array(a) => a.iter().all(|x| !x.is_array() && no_nested_arrays(x)),
        Value::Object(m) => m.values().all(no_nested_arrays),
        _ => true,
    }
}

proptest! {
    #![proptest_config(ProptestConfig { cases: 400, .. ProptestConfig::default() })]

    #[test]
    fn json_yaml_json_identical(v in json_value()) {
        let y = yaml::to_yaml(&v);
        let back = yaml::parse_yaml(&y, &Options::default()).map_err(|e| TestCaseError::fail(format!("{e} in\n{y}")))?;
        prop_assert_eq!(serde_json::to_string(&back).unwrap(), serde_json::to_string(&v).unwrap(), "yaml was:\n{}", y);
    }

    #[test]
    fn json_xml_json_identical(name in xml_name(), v in xml_value(false)) {
        let doc = Value::Object([(name, v)].into_iter().collect());
        prop_assume!(no_nested_arrays(&doc));
        let o = Options::default();
        let x = xml::to_xml(&doc, &o).unwrap();
        let back = xml::parse_xml(&x, &o).map_err(|e| TestCaseError::fail(format!("{e} in\n{x}")))?;
        prop_assert_eq!(serde_json::to_string(&back).unwrap(), serde_json::to_string(&doc).unwrap(), "xml was:\n{}", x);
    }

    #[test]
    fn json_xml_json_identical_typed(name in xml_name(), v in xml_value(true)) {
        let doc = Value::Object([(name, v)].into_iter().collect());
        prop_assume!(no_nested_arrays(&doc));
        let mut o = Options::default(); o.infer_types = true;
        let x = xml::to_xml(&doc, &o).unwrap();
        let back = xml::parse_xml(&x, &o).unwrap();
        prop_assert_eq!(serde_json::to_string(&back).unwrap(), serde_json::to_string(&doc).unwrap(), "xml was:\n{}", x);
    }

    #[test]
    fn parsers_never_panic(s in "\\PC{0,64}") {
        let o = Options::default();
        let _ = yaml::parse_yaml(&s, &o);
        let _ = xml::parse_xml(&s, &o);
        let _ = parse_json(&s);
    }

    #[test]
    fn json_to_xml_never_panics_and_is_wellformed(v in json_value()) {
        let o = Options::default();
        if let Ok(x) = xml::to_xml(&v, &o) {
            prop_assert!(xml::parse_xml(&x, &o).is_ok(), "not well-formed:\n{}", x);
        }
    }
}
#[allow(dead_code)] fn _n(_: Number) {}
