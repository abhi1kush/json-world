//! YAML <-> JSON using yaml-rust2's event parser with our own YAML 1.2 core-schema resolver.
use crate::{ConvError, Options};
use serde_json::{Map, Value};
use std::collections::{HashMap, HashSet};
use yaml_rust2::parser::{MarkedEventReceiver, Parser, Tag};
use yaml_rust2::scanner::{Marker, TScalarStyle};
use yaml_rust2::Event;

// ---------------------------------------------------------------- resolver
fn is_digits(s: &str) -> bool { !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()) }

/// Canonical JSON text for a YAML core-schema int, or None.
fn resolve_int(s: &str) -> Option<Result<String, String>> {
    let (neg, body) = match s.as_bytes().first() { Some(b'-') => (true, &s[1..]), Some(b'+') => (false, &s[1..]), _ => (false, s) };
    if is_digits(body) {
        let t = body.trim_start_matches('0');
        let t = if t.is_empty() { "0" } else { t };
        return Some(Ok(format!("{}{}", if neg { "-" } else { "" }, t)));
    }
    if s.len() > 2 && (s.starts_with("0x") || s.starts_with("0o")) {
        let (radix, digits) = if s.starts_with("0x") { (16, &s[2..]) } else { (8, &s[2..]) };
        if !digits.chars().all(|c| c.is_digit(radix)) { return None; }
        return Some(u128::from_str_radix(digits, radix).map(|n| n.to_string()).map_err(|_| format!("Integer '{s}' is too large")));
    }
    None
}
/// Canonical JSON text for a YAML core-schema float, or None.
fn resolve_float(s: &str) -> Option<Result<String, String>> {
    if matches!(s, ".inf" | ".Inf" | ".INF" | "+.inf" | "+.Inf" | "+.INF" | "-.inf" | "-.Inf" | "-.INF" | ".nan" | ".NaN" | ".NAN") {
        return Some(Err(format!("'{s}' (infinity/NaN) cannot be represented in JSON")));
    }
    let (sign, body) = match s.as_bytes().first() { Some(b'-') => ("-", &s[1..]), Some(b'+') => ("", &s[1..]), _ => ("", s) };
    let (mant, exp) = match body.find(['e', 'E']) { Some(i) => (&body[..i], Some(&body[i + 1..])), None => (body, None) };
    if let Some(e) = exp {
        let ed = e.strip_prefix(['+', '-']).unwrap_or(e);
        if !is_digits(ed) { return None; }
    }
    let (ip, fp) = match mant.find('.') { Some(i) => (&mant[..i], Some(&mant[i + 1..])), None => (mant, None) };
    let ok = match fp { Some(f) => (is_digits(ip) && (f.is_empty() || is_digits(f))) || (ip.is_empty() && is_digits(f)), None => is_digits(ip) };
    if !ok { return None; }
    let ip2 = ip.trim_start_matches('0'); let ip2 = if ip2.is_empty() { "0" } else { ip2 };
    let mut out = format!("{sign}{ip2}");
    if let Some(f) = fp { out.push('.'); out.push_str(if f.is_empty() { "0" } else { f }); }
    if let Some(e) = exp { out.push('e'); out.push_str(e); }
    Some(Ok(out))
}

/// Resolve a plain scalar with the YAML 1.2 core schema.
pub fn resolve_plain(s: &str) -> Result<Value, String> {
    match s {
        "" | "~" | "null" | "Null" | "NULL" => return Ok(Value::Null),
        "true" | "True" | "TRUE" => return Ok(Value::Bool(true)),
        "false" | "False" | "FALSE" => return Ok(Value::Bool(false)),
        _ => {}
    }
    let num = resolve_int(s).or_else(|| resolve_float(s));
    match num {
        Some(Ok(t)) => Ok(serde_json::from_str::<Value>(&t).map_err(|e| e.to_string())?),
        Some(Err(e)) => Err(e),
        None => Ok(Value::String(s.to_string())),
    }
}

fn tag_suffix(t: &Option<Tag>) -> Option<&str> {
    t.as_ref().and_then(|t| if t.handle == "!!" || t.handle == "tag:yaml.org,2002:" { Some(t.suffix.as_str()) } else { None })
}

// ---------------------------------------------------------------- loader
enum Frame {
    Seq { items: Vec<Value>, anchor: usize },
    Map { map: Map<String, Value>, key: Option<(String, bool)>, anchor: usize, merged: HashSet<String>, start: Marker },
}
struct Builder {
    stack: Vec<Frame>,
    docs: Vec<Value>,
    anchors: HashMap<usize, Value>,
    err: Option<ConvError>,
}
fn err_at(m: &str, mk: &Marker) -> ConvError { ConvError::at(m, mk.line(), mk.col() + 1) }

impl Builder {
    fn finish(&mut self, v: Value, anchor: usize, is_plain_merge_key: bool, mk: &Marker) {
        if anchor > 0 { self.anchors.insert(anchor, v.clone()); }
        match self.stack.last_mut() {
            None => self.docs.push(v),
            Some(Frame::Seq { items, .. }) => items.push(v),
            Some(Frame::Map { map, key, merged, .. }) => match key.take() {
                None => {
                    // this value is a key
                    let k = match v {
                        Value::String(s) => s,
                        Value::Null => String::new(),
                        Value::Bool(b) => b.to_string(),
                        Value::Number(n) => n.to_string(),
                        _ => { self.err.get_or_insert(err_at("Complex (mapping/sequence) keys are not supported in JSON", mk)); return; }
                    };
                    *key = Some((k, is_plain_merge_key));
                }
                Some((k, is_merge)) => {
                    if is_merge {
                        let sources: Vec<Value> = match v { Value::Array(a) => a, other => vec![other] };
                        for src in sources {
                            match src {
                                Value::Object(m) => for (mk2, mv) in m {
                                    if !map.contains_key(&mk2) { merged.insert(mk2.clone()); map.insert(mk2, mv); }
                                },
                                _ => { self.err.get_or_insert(err_at("Merge key '<<' value must be a mapping or a list of mappings", mk)); return; }
                            }
                        }
                    } else {
                        if map.contains_key(&k) && !merged.remove(&k) {
                            self.err.get_or_insert(err_at(&format!("Duplicate key '{k}'"), mk));
                            return;
                        }
                        map.insert(k, v);
                    }
                }
            },
        }
    }
}

impl MarkedEventReceiver for Builder {
    fn on_event(&mut self, ev: Event, mk: Marker) {
        if self.err.is_some() { return; }
        match ev {
            Event::SequenceStart(anchor, _) => self.stack.push(Frame::Seq { items: vec![], anchor }),
            Event::MappingStart(anchor, _) => self.stack.push(Frame::Map { map: Map::new(), key: None, anchor, merged: HashSet::new(), start: mk }),
            Event::SequenceEnd => {
                if let Some(Frame::Seq { items, anchor }) = self.stack.pop() { self.finish(Value::Array(items), anchor, false, &mk); }
            }
            Event::MappingEnd => {
                if let Some(Frame::Map { map, anchor, start, .. }) = self.stack.pop() { self.finish(Value::Object(map), anchor, false, &start); }
            }
            Event::Alias(id) => match self.anchors.get(&id).cloned() {
                Some(v) => self.finish(v, 0, false, &mk),
                None => { self.err = Some(err_at("Unknown alias", &mk)); }
            },
            Event::Scalar(s, style, anchor, tag) => {
                let is_key_pos = matches!(self.stack.last(), Some(Frame::Map { key: None, .. }));
                let plain = style == TScalarStyle::Plain;
                let v = match tag_suffix(&tag) {
                    Some("str") => Ok(Value::String(s.clone())),
                    Some("null") => Ok(Value::Null),
                    Some("bool") | Some("int") | Some("float") => resolve_plain(&s).and_then(|v| if v.is_string() { Err(format!("'{s}' is not a valid !!{}", tag.as_ref().unwrap().suffix)) } else { Ok(v) }),
                    _ if !plain => Ok(Value::String(s.clone())),
                    _ if is_key_pos => Ok(Value::String(s.clone())), // keys keep their literal text
                    _ => resolve_plain(&s),
                };
                match v {
                    Ok(v) => self.finish(v, anchor, plain && is_key_pos && s == "<<", &mk),
                    Err(e) => { self.err = Some(err_at(&e, &mk)); }
                }
            }
            _ => {}
        }
    }
}

pub fn parse_yaml(input: &str, o: &Options) -> Result<Value, ConvError> {
    let mut b = Builder { stack: vec![], docs: vec![], anchors: HashMap::new(), err: None };
    let mut p = Parser::new_from_str(input);
    p.load(&mut b, true).map_err(|e| err_at(e.info(), e.marker()))?;
    if let Some(e) = b.err { return Err(e); }
    match b.docs.len() {
        0 => Ok(Value::Null),
        1 => Ok(b.docs.pop().unwrap()),
        n if o.multi_doc == "error" => Err(ConvError::new(format!("Input has {n} YAML documents; expected one"))),
        _ => Ok(Value::Array(b.docs)),
    }
}

// ---------------------------------------------------------------- emitter
fn plain_ok(s: &str) -> bool {
    let first = match s.chars().next() { Some(c) => c, None => return false };
    if !(first.is_ascii_alphanumeric() || first == '_' || first == '/') { return false; }
    if s.ends_with(' ') { return false; }
    if !s.chars().all(|c| c.is_ascii_alphanumeric() || " _.-/".contains(c)) { return false; }
    matches!(resolve_plain(s), Ok(Value::String(_)))
}
pub fn quote(s: &str) -> String {
    let mut o = String::with_capacity(s.len() + 2);
    o.push('"');
    for c in s.chars() {
        match c {
            '"' => o.push_str("\\\""), '\\' => o.push_str("\\\\"),
            '\n' => o.push_str("\\n"), '\t' => o.push_str("\\t"), '\r' => o.push_str("\\r"),
            '\u{85}' => o.push_str("\\N"), '\u{a0}' => o.push_str("\\_"),
            '\u{2028}' => o.push_str("\\L"), '\u{2029}' => o.push_str("\\P"),
            c if (c as u32) < 0x20 || (0x7f..=0x9f).contains(&(c as u32)) || c == '\u{feff}' || (0xd800..=0xdfff).contains(&(c as u32)) || c == '\u{fffe}' || c == '\u{ffff}' => o.push_str(&format!("\\u{:04X}", c as u32)),
            c => o.push(c),
        }
    }
    o.push('"');
    o
}
fn scalar(v: &Value) -> Option<String> {
    Some(match v {
        Value::Null => "null".into(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => n.to_string(),
        Value::String(s) => if plain_ok(s) { s.clone() } else { quote(s) },
        Value::Array(a) if a.is_empty() => "[]".into(),
        Value::Object(m) if m.is_empty() => "{}".into(),
        _ => return None,
    })
}
fn key(s: &str) -> String { if plain_ok(s) { s.to_string() } else { quote(s) } }

fn emit(v: &Value, ind: usize, out: &mut String) {
    let pad = " ".repeat(ind);
    match v {
        Value::Object(m) if !m.is_empty() => for (k, val) in m {
            out.push_str(&pad); out.push_str(&key(k)); out.push(':');
            match scalar(val) {
                Some(s) => { out.push(' '); out.push_str(&s); out.push('\n'); }
                None => { out.push('\n'); emit(val, ind + 2, out); }
            }
        },
        Value::Array(a) if !a.is_empty() => for item in a {
            match scalar(item) {
                Some(s) => { out.push_str(&pad); out.push_str("- "); out.push_str(&s); out.push('\n'); }
                None => {
                    let mut child = String::new();
                    emit(item, ind + 2, &mut child);
                    out.push_str(&pad); out.push_str("- ");
                    out.push_str(&child[ind + 2..]);
                }
            }
        },
        other => { out.push_str(&pad); out.push_str(&scalar(other).unwrap()); out.push('\n'); }
    }
}
pub fn to_yaml(v: &Value) -> String {
    let mut out = String::new();
    emit(v, 0, &mut out);
    out
}
