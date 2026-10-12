//! JSON / YAML / XML / Java .properties converter used by json-world (compiled to WASM).
//!
//! Every conversion goes through `serde_json::Value` (key order preserved, numbers kept as
//! their exact decimal text thanks to `arbitrary_precision`).
//! See `CONVENTIONS.md` for the YAML and XML mapping rules.

pub mod properties;
pub mod xml;
pub mod yaml;

use serde_json::Value;
use wasm_bindgen::prelude::*;

#[derive(Debug, Clone, PartialEq)]
pub struct ConvError {
    pub message: String,
    pub line: Option<usize>,
    pub col: Option<usize>,
}
impl ConvError {
    pub fn new(m: impl Into<String>) -> Self { ConvError { message: m.into(), line: None, col: None } }
    pub fn at(m: impl Into<String>, line: usize, col: usize) -> Self { ConvError { message: m.into(), line: Some(line), col: Some(col) } }
}
impl std::fmt::Display for ConvError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match (self.line, self.col) {
            (Some(l), Some(c)) => write!(f, "{} (line {}, col {})", self.message, l, c),
            _ => write!(f, "{}", self.message),
        }
    }
}

#[derive(Debug, Clone)]
pub struct Options {
    /// Root element name used by JSON->XML when the value isn't a single-key object.
    pub root_name: String,
    /// "sanitize" (default) or "error" for invalid XML element/attribute names.
    pub invalid_names: String,
    /// XML->JSON: convert "true"/"false" and JSON-number text to booleans/numbers.
    pub infer_types: bool,
    /// Indentation for JSON / XML output.
    pub indent: usize,
    /// YAML->JSON with several documents: "array" (default) or "error".
    pub multi_doc: String,
    /// JSON->properties: write non-ASCII as \uXXXX (default true, like Properties.store).
    pub escape_unicode: bool,
}
impl Default for Options {
    fn default() -> Self {
        Options { root_name: "root".into(), invalid_names: "sanitize".into(), infer_types: false, indent: 2, multi_doc: "array".into(), escape_unicode: true }
    }
}
impl Options {
    pub fn from_json(s: &str) -> Options {
        let mut o = Options::default();
        if let Ok(Value::Object(m)) = serde_json::from_str::<Value>(s) {
            if let Some(Value::String(v)) = m.get("rootName") { if !v.is_empty() { o.root_name = v.clone(); } }
            if let Some(Value::String(v)) = m.get("invalidNames") { o.invalid_names = v.clone(); }
            if let Some(Value::Bool(v)) = m.get("inferTypes") { o.infer_types = *v; }
            if let Some(Value::String(v)) = m.get("multiDoc") { o.multi_doc = v.clone(); }
            if let Some(Value::Bool(v)) = m.get("escapeUnicode") { o.escape_unicode = *v; }
            if let Some(n) = m.get("indent").and_then(|v| v.as_u64()) { o.indent = (n as usize).min(8); }
        }
        o
    }
}

pub fn parse_json(input: &str) -> Result<Value, ConvError> {
    serde_json::from_str(input).map_err(|e| ConvError::at(strip_pos(&e.to_string()), e.line(), e.column()))
}
fn strip_pos(s: &str) -> String {
    match s.rfind(" at line ") { Some(i) => s[..i].to_string(), None => s.to_string() }
}
pub fn to_json(v: &Value, indent: usize) -> String {
    if indent == 0 { return serde_json::to_string(v).unwrap(); }
    let ind = vec![b' '; indent];
    let mut out = Vec::new();
    let fmt = serde_json::ser::PrettyFormatter::with_indent(&ind);
    let mut ser = serde_json::Serializer::with_formatter(&mut out, fmt);
    serde::Serialize::serialize(v, &mut ser).unwrap();
    String::from_utf8(out).unwrap()
}

pub fn parse(input: &str, from: &str, o: &Options) -> Result<Value, ConvError> {
    match from {
        "json" => parse_json(input),
        "yaml" => yaml::parse_yaml(input, o),
        "xml" => xml::parse_xml(input, o),
        "properties" => properties::parse_properties(input, o),
        f => Err(ConvError::new(format!("Unknown input format '{f}'"))),
    }
}
pub fn emit(v: &Value, to: &str, o: &Options) -> Result<String, ConvError> {
    match to {
        "json" => Ok(to_json(v, o.indent)),
        "yaml" => Ok(yaml::to_yaml(v)),
        "xml" => xml::to_xml(v, o),
        "properties" => properties::to_properties(v, o),
        t => Err(ConvError::new(format!("Unknown output format '{t}'"))),
    }
}
pub fn convert_str(input: &str, from: &str, to: &str, o: &Options) -> Result<String, ConvError> {
    let v = parse(input, from, o)?;
    emit(&v, to, o)
}

/// WASM entry point. Returns a JSON string: `{"ok":true,"output":"..."}` or
/// `{"ok":false,"message":"...","line":n|null,"col":n|null}`.
#[wasm_bindgen]
pub fn convert(input: &str, from: &str, to: &str, options: &str) -> String {
    let o = Options::from_json(options);
    let r = match convert_str(input, from, to, &o) {
        Ok(out) => serde_json::json!({ "ok": true, "output": out }),
        Err(e) => serde_json::json!({ "ok": false, "message": e.message, "line": e.line, "col": e.col }),
    };
    r.to_string()
}

#[wasm_bindgen]
pub fn version() -> String { env!("CARGO_PKG_VERSION").to_string() }

/// Line/col (1-based) of a byte offset.
pub(crate) fn line_col(s: &str, offset: usize) -> (usize, usize) {
    let off = offset.min(s.len());
    let mut line = 1; let mut col = 1;
    for (i, ch) in s.char_indices() {
        if i >= off { break; }
        if ch == '\n' { line += 1; col = 1; } else { col += 1; }
    }
    (line, col)
}
