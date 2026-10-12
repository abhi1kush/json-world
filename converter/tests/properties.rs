use converter::{convert_str, properties::*, Options};
use serde_json::{json, Value};

fn o() -> Options { Options::default() }
fn oi() -> Options { let mut x = o(); x.infer_types = true; x }
fn to(v: Value) -> String { to_properties(&v, &o()).unwrap() }
fn from(s: &str) -> Value { parse_properties(s, &o()).unwrap() }
fn err(s: &str) -> (usize, usize, String) { let e = parse_properties(s, &o()).unwrap_err(); (e.line.unwrap(), e.col.unwrap(), e.message) }

#[test] fn flatten_nested_arrays_scalars() {
    let v = json!({"server":{"port":8080,"ssl":true,"hosts":["a","b"],"users":[{"n":"x"},{"n":"y","tags":[[1,2]]}]},"nil":null,"eo":{},"ea":[],"s":"hi"});
    assert_eq!(to(v), "server.port=8080\nserver.ssl=true\nserver.hosts[0]=a\nserver.hosts[1]=b\nserver.users[0].n=x\nserver.users[1].n=y\nserver.users[1].tags[0][0]=1\nserver.users[1].tags[0][1]=2\nnil=\neo=\nea=\ns=hi\n");
}
#[test] fn exact_numbers() { assert_eq!(to(serde_json::from_str(r#"{"n":123456789012345678901234567890,"f":1.50}"#).unwrap()), "n=123456789012345678901234567890\nf=1.50\n"); }
#[test] fn escaping() {
    assert_eq!(escape("a b=c:d#e!f\\g", true, true), "a\\ b\\=c\\:d\\#e\\!f\\\\g");
    assert_eq!(escape("  lead and inner  ", false, true), "\\  lead and inner  ");
    assert_eq!(escape("l1\nl2\r\t\x0C", false, true), "l1\\nl2\\r\\t\\f");
    assert_eq!(escape("é€😀", false, true), "\\u00E9\\u20AC\\uD83D\\uDE00");
    assert_eq!(escape("é€😀", false, false), "é€😀");
    assert_eq!(escape("\x01\x7F", false, false), "\\u0001\\u007F");
}
#[test] fn top_level_and_bad_keys_error() {
    for t in [json!(5), json!("s"), json!(null), json!([1])] { assert!(to_properties(&t, &o()).unwrap_err().message.contains("top-level")); }
    assert!(to_properties(&json!({"a":{"b.c":1}}), &o()).unwrap_err().message.contains("Key 'b.c' at $.a.b.c"));
    assert!(to_properties(&json!({"a[0]":1}), &o()).is_err());
    assert!(to_properties(&json!({"":1}), &o()).is_err());
}
#[test] fn parse_syntax() {
    let src = "# comment\n! bang comment\n   \nkey1=v1\nkey2 = v2\nkey3:v3\nkey4 v4\n  key5\t:  v5  \nempty=\nbare\nmulti = a,\\\n        b,\\\n  c\nesc\\ key\\:x = \\ lead\\tT\\u00E9\\n\nwin=1\r\nmac=2\rlast=3";
    assert_eq!(from(src), json!({"key1":"v1","key2":"v2","key3":"v3","key4":"v4","key5":"v5  ","empty":"","bare":"","multi":"a,b,c","esc key:x":" lead\tTé\n","win":"1","mac":"2","last":"3"}));
    // a comment line ending with '\' does not continue; an even number of trailing backslashes doesn't either
    assert_eq!(from("# c \\\na=1\nb=x\\\\\nc=2"), json!({"a":"1","b":"x\\","c":"2"}));
    assert_eq!(from("s=\\uD83D\\uDE00"), json!({"s":"😀"}));
}
#[test] fn unflatten() {
    assert_eq!(from("a.b[1]=y\na.b[0]=x\na.c.d=1\nm[0][1]=q\nm[0][0]=p"), json!({"a":{"b":["x","y"],"c":{"d":"1"}},"m":[["p","q"]]}));
    assert_eq!(from("a=1\na=2"), json!({"a":"2"}));
    assert_eq!(parse_properties("i=42\nf=-1.5\nb=true\ns=hello\nz=007\ne=", &oi()).unwrap(), json!({"i":42,"f":-1.5,"b":true,"s":"hello","z":"007","e":""}));
}
#[test] fn conflicts_and_bad_keys_have_positions() {
    let (l, c, m) = err("a=1\n  a.b=2"); assert_eq!((l, c), (2, 3)); assert!(m.contains("Conflicting keys") && m.contains("line 1, column 1"), "{m}");
    let (l, _, m) = err("a.b=2\na=1"); assert_eq!(l, 2); assert!(m.contains("Conflicting"), "{m}");
    let (l, _, m) = err("a[0]=1\na.x=2"); assert_eq!(l, 2); assert!(m.contains("array"), "{m}");
    let (l, _, m) = err("a.x=1\na[0]=2"); assert_eq!(l, 2); assert!(m.contains("object"), "{m}");
    let (l, _, m) = err("a[0]=1\na[2]=3"); assert_eq!(l, 2); assert!(m.contains("no element [1]"), "{m}");
    for k in ["a..b", ".a", "a.", "a[x]", "a[1", "a[01]", "[0]", "a]b", "a[0]x", "a.[0]", "=v"] { assert!(parse_properties(&format!("{k}=1"), &o()).is_err(), "{k}"); }
    let (l, c, m) = err("ok=1\nx=\\u12G4"); assert_eq!((l, c), (2, 3)); assert!(m.contains("\\uXXXX"), "{m}");
}
#[test] fn round_trips() {
    for src in [
        r#"{"server":{"port":8080,"ssl":true,"name":"api","hosts":["a","b"],"users":[{"n":"x","roles":["r1","r2"]},{"n":"y"}]},"ratio":0.25,"big":123456789012345678901234567890}"#,
        r#"{"m":[[1,2],[3,[4,5]]],"k":{"a b":"  sp","eq=":"x:y#z!w\\","nl":"l1\nl2\tt","u":"é😀"}}"#,
    ] {
        let v: Value = serde_json::from_str(src).unwrap();
        for esc in [true, false] {
            let mut opt = oi(); opt.escape_unicode = esc;
            let p = to_properties(&v, &opt).unwrap();
            assert_eq!(parse_properties(&p, &opt).unwrap(), v, "{p}");
        }
    }
    // via the public string API
    let out = convert_str("a:\n  - 1\n  - x: y\n", "yaml", "properties", &o()).unwrap();
    assert_eq!(out, "a[0]=1\na[1].x=y\n");
    assert_eq!(convert_str(&out, "properties", "json", &oi()).unwrap(), "{\n  \"a\": [\n    1,\n    {\n      \"x\": \"y\"\n    }\n  ]\n}");
}
