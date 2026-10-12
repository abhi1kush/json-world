use converter::*;
use serde_json::{json, Value};

fn o() -> Options { Options::default() }
fn j(s: &str) -> Value { parse_json(s).unwrap() }
fn y2j(s: &str) -> Value { yaml::parse_yaml(s, &o()).unwrap() }
fn x2j(s: &str) -> Value { xml::parse_xml(s, &o()).unwrap() }
fn j2x(v: &Value) -> String { xml::to_xml(v, &o()).unwrap() }
fn txt(v: &Value) -> String { serde_json::to_string(v).unwrap() }

// ------------------------------------------------------------- JSON
#[test] fn json_errors_have_position() {
    let e = parse_json("{\n  \"a\": 1,\n}").unwrap_err();
    assert_eq!((e.line, e.col), (Some(3), Some(1)));
}
#[test] fn json_keeps_order_and_big_ints() {
    let v = j(r##"{"b":1,"a":123456789012345678901234567890,"c":1.50}"##);
    assert_eq!(txt(&v), r##"{"b":1,"a":123456789012345678901234567890,"c":1.50}"##);
}

// ------------------------------------------------------------- YAML
#[test] fn yaml_basic_types_core_schema() {
    let v = y2j("a: 1\nb: -2.5\nc: true\nd: null\ne: ~\nf: hello world\ng: '1'\nh: 0x1F\ni: 0o17\nj: 1e3\nk: yes\nl: .5\nm: +7\nn: 007\n");
    assert_eq!(txt(&v), r##"{"a":1,"b":-2.5,"c":true,"d":null,"e":null,"f":"hello world","g":"1","h":31,"i":15,"j":1e+3,"k":"yes","l":0.5,"m":7,"n":7}"##);
}
#[test] fn yaml_keeps_key_order() {
    assert_eq!(txt(&y2j("z: 1\na: 2\n10: 3\n2: 4\n")), r##"{"z":1,"a":2,"10":3,"2":4}"##);
}
#[test] fn yaml_big_ints_exact() {
    assert_eq!(txt(&y2j("n: 123456789012345678901234567890\nm: -99999999999999999999\n")), r##"{"n":123456789012345678901234567890,"m":-99999999999999999999}"##);
}
#[test] fn yaml_anchors_and_merge() {
    let v = y2j("base: &b\n  x: 1\n  y: 2\nref: *b\nd:\n  <<: *b\n  y: 3\n  z: 4\nlist: &l [1, 2]\nl2: *l\n");
    assert_eq!(v["ref"], json!({"x":1,"y":2}));
    assert_eq!(txt(&v["d"]), r##"{"x":1,"y":3,"z":4}"##);
    assert_eq!(v["l2"], json!([1, 2]));
}
#[test] fn yaml_duplicate_key_error() {
    let e = yaml::parse_yaml("a: 1\na: 2\n", &o()).unwrap_err();
    assert!(e.message.contains("Duplicate key"));
    assert_eq!(e.line, Some(2));
}
#[test] fn yaml_multi_documents() {
    assert_eq!(y2j("a: 1\n---\nb: 2\n"), json!([{"a":1},{"b":2}]));
    let mut opt = o(); opt.multi_doc = "error".into();
    assert!(yaml::parse_yaml("a: 1\n---\nb: 2\n", &opt).is_err());
    assert_eq!(y2j(""), Value::Null);
}
#[test] fn yaml_syntax_error_position() {
    let e = yaml::parse_yaml("a: 1\nb: [1, 2\nc: 3\n", &o()).unwrap_err();
    assert!(e.line.is_some() && e.col.is_some(), "{e:?}");
    let e = yaml::parse_yaml("key: \"unterminated\n", &o()).unwrap_err();
    assert!(e.line.is_some());
}
#[test] fn yaml_error_col_is_one_based() {
    let e = yaml::parse_yaml("a: 1\n  b: 2\n", &o()).unwrap_err();
    assert_eq!(e.line, Some(2)); assert!(e.col.unwrap() >= 1);
}
#[test] fn yaml_inf_nan_rejected() { assert!(yaml::parse_yaml("a: .inf", &o()).is_err()); assert!(yaml::parse_yaml("a: .nan", &o()).is_err()); }
#[test] fn yaml_tags() {
    assert_eq!(y2j("a: !!str 12\nb: !!int \"5\"\n"), json!({"a":"12","b":5}));
}
#[test] fn yaml_block_scalars() {
    assert_eq!(y2j("a: |\n  line1\n  line2\nb: >\n  folded\n  text\n"), json!({"a":"line1\nline2\n","b":"folded text\n"}));
}
#[test] fn yaml_complex_key_error() { assert!(yaml::parse_yaml("? [1, 2]\n: x\n", &o()).is_err()); }
#[test] fn yaml_emit_quotes_ambiguous_strings() {
    let v = json!({"a":"true","b":"123","c":"","d":"null","e":"a: b","f":"- x","g":"plain text","h":"#c","i":"line\nbreak","j":"yes","k":" lead","l":"1e5","m":"~","n":"0x10"});
    let y = yaml::to_yaml(&v);
    assert!(y.contains("g: plain text\n"));
    assert_eq!(y2j(&y), v, "{y}");
}
#[test] fn yaml_emit_structure() {
    let v = j(r##"{"a":[1,{"b":2,"c":[3,[4,5]]},[],{}],"d":{"e":null}}"##);
    let y = yaml::to_yaml(&v);
    assert_eq!(y, "a:\n  - 1\n  - b: 2\n    c:\n      - 3\n      - - 4\n        - 5\n  - []\n  - {}\nd:\n  e: null\n");
    assert_eq!(y2j(&y), v);
}
#[test] fn yaml_scalar_roots() {
    for s in [r##""x""##, "1", "null", "true", "[]", "{}", r##""""##] { let v = j(s); assert_eq!(y2j(&yaml::to_yaml(&v)), v, "{s}"); }
}

// ------------------------------------------------------------- XML -> JSON
#[test] fn xml_root_attrs_text_repeats() {
    let v = x2j(r##"<?xml version="1.0"?><!-- c --><lib id="1"><book lang="en">A</book><book>B</book><name>X</name><empty/><empty2></empty2></lib>"##);
    assert_eq!(txt(&v), r##"{"lib":{"@id":"1","book":[{"@lang":"en","#text":"A"},"B"],"name":"X","empty":null,"empty2":null}}"##);
}
#[test] fn xml_mixed_content_and_cdata() {
    let v = x2j("<a>hello <b>x</b> world<![CDATA[ <raw> & ]]></a>");
    assert_eq!(v, json!({"a":{"b":"x","#text":"helloworld <raw> & "}}));
}
#[test] fn xml_namespaces_kept() {
    let v = x2j(r##"<soap:Envelope xmlns:soap="http://s"><soap:Body/></soap:Envelope>"##);
    assert_eq!(v, json!({"soap:Envelope":{"@xmlns:soap":"http://s","soap:Body":null}}));
}
#[test] fn xml_entities_unescaped() {
    assert_eq!(x2j(r##"<a t="&quot;&amp;">&lt;&#65;&#x42;&gt;</a>"##), json!({"a":{"@t":"\"&","#text":"<AB>"}}));
}
#[test] fn xml_whitespace_trimmed() { assert_eq!(x2j("<a>\n  <b>  x y  </b>\n</a>"), json!({"a":{"b":"x y"}})); }
#[test] fn xml_infer_types() {
    let mut opt = o(); opt.infer_types = true;
    assert_eq!(txt(&xml::parse_xml("<a><n>12</n><f>1.5e3</f><b>true</b><s>012</s><t>abc</t></a>", &opt).unwrap()), r##"{"a":{"n":12,"f":1.5e+3,"b":true,"s":"012","t":"abc"}}"##);
    assert_eq!(x2j("<a><n>12</n></a>"), json!({"a":{"n":"12"}}));
}
#[test] fn xml_errors_have_position() {
    let e = xml::parse_xml("<a>\n  <b>\n</a>", &o()).unwrap_err();
    assert_eq!(e.line, Some(3), "{e:?}");
    let e = xml::parse_xml("<a></a><b/>", &o()).unwrap_err();
    assert!(e.message.contains("Multiple root"));
    assert!(xml::parse_xml("", &o()).is_err());
    assert!(xml::parse_xml("<a>", &o()).unwrap_err().message.contains("Unclosed"));
    assert!(xml::parse_xml("<a x='1' x='2'/>", &o()).is_err());
}

// ------------------------------------------------------------- JSON -> XML
#[test] fn json_to_xml_single_key_root() {
    let x = j2x(&j(r##"{"lib":{"@id":"1","book":[{"@lang":"en","#text":"A"},"B"],"n":5,"ok":true,"none":null,"e":""}}"##));
    assert_eq!(x, "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<lib id=\"1\">\n  <book lang=\"en\">A</book>\n  <book>B</book>\n  <n>5</n>\n  <ok>true</ok>\n  <none/>\n  <e></e>\n</lib>\n");
}
#[test] fn json_to_xml_root_name_wrapping() {
    let mut opt = o(); opt.root_name = "data".into();
    assert!(xml::to_xml(&j(r##"{"a":1,"b":2}"##), &opt).unwrap().contains("<data>\n  <a>1</a>\n  <b>2</b>\n</data>"));
    assert!(xml::to_xml(&j("[1,2]"), &opt).unwrap().contains("<data>\n  <item>1</item>\n  <item>2</item>\n</data>"));
    assert!(xml::to_xml(&j("5"), &opt).unwrap().contains("<data>5</data>"));
    assert!(xml::to_xml(&j(r##"{"a":[1,2]}"##), &opt).unwrap().contains("<data>\n  <a>1</a>\n  <a>2</a>\n</data>"));
}
#[test] fn json_to_xml_invalid_names() {
    let x = j2x(&j(r##"{"r":{"1st":1,"a b":2,"ok-name":3,"":4,"ns:x":5}}"##));
    assert!(x.contains("<_1st>1</_1st>") && x.contains("<a_b>2</a_b>") && x.contains("<ok-name>3</ok-name>") && x.contains("<_>4</_>") && x.contains("<ns:x>5</ns:x>"), "{x}");
    let mut opt = o(); opt.invalid_names = "error".into();
    assert!(xml::to_xml(&j(r##"{"r":{"1st":1}}"##), &opt).unwrap_err().message.contains("1st"));
}
#[test] fn json_to_xml_escaping() {
    let v = j(r##"{"a":{"@q":"\"<&>\n","#text":"<&> ]]> \r"}}"##);
    let x = j2x(&v);
    assert!(x.contains(r##"q="&quot;&lt;&amp;&gt;&#10;""##), "{x}");
    assert_eq!(x2j(&x)["a"]["@q"], json!("\"<&>\n"));
    assert!(xml::to_xml(&j(r##"{"a":"\u0001"}"##), &o()).is_err());
}
#[test] fn json_to_xml_attribute_must_be_primitive() { assert!(xml::to_xml(&j(r##"{"a":{"@x":{"y":1}}}"##), &o()).is_err()); }
#[test] fn xml_round_trip_example() {
    let v = j(r##"{"catalog":{"@xmlns:x":"urn:x","x:item":[{"@id":"1","name":"A","tags":{"tag":["t1","t2"]}},{"@id":"2","name":"B","#text":"note"}],"meta":null}}"##);
    assert_eq!(x2j(&j2x(&v)), v);
}

// ------------------------------------------------------------- wasm entry
#[test] fn convert_entry_json_shape() {
    let r: Value = serde_json::from_str(&convert("{\"a\":1}", "json", "yaml", "{}")).unwrap();
    assert_eq!(r, json!({"ok":true,"output":"a: 1\n"}));
    let r: Value = serde_json::from_str(&convert("{", "json", "yaml", "{}")).unwrap();
    assert_eq!(r["ok"], json!(false)); assert!(r["line"].is_number());
    let r: Value = serde_json::from_str(&convert("[1]", "json", "xml", r##"{"rootName":"list","indent":0}"##)).unwrap();
    assert_eq!(r["output"], json!("<?xml version=\"1.0\" encoding=\"UTF-8\"?><list><item>1</item></list>"));
}
