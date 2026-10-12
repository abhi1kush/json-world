//! XML <-> JSON mapping (see CONVENTIONS.md).
use crate::{line_col, ConvError, Options};
use quick_xml::events::Event;
use quick_xml::Reader;
use serde_json::{Map, Value};

// ---------------------------------------------------------------- XML -> JSON
struct Elem { pos: u64, name: String, map: Map<String, Value>, text: String, has_text: bool }

fn add_child(map: &mut Map<String, Value>, name: String, v: Value) {
    match map.get_mut(&name) {
        // XML never produces array values except for repeated elements, so an existing array is a repeat list.
        Some(Value::Array(a)) => a.push(v),
        Some(existing) => { let prev = existing.take(); *existing = Value::Array(vec![prev, v]); }
        None => { map.insert(name, v); }
    }
}

pub(crate) fn infer(s: String, o: &Options) -> Value {
    if o.infer_types {
        if s == "true" { return Value::Bool(true); }
        if s == "false" { return Value::Bool(false); }
        if is_json_number(&s) { if let Ok(v) = serde_json::from_str::<Value>(&s) { return v; } }
    }
    Value::String(s)
}
fn is_json_number(s: &str) -> bool {
    let b = s.as_bytes(); let mut i = 0;
    if i < b.len() && b[i] == b'-' { i += 1; }
    if i >= b.len() { return false; }
    if b[i] == b'0' { i += 1; } else if b[i].is_ascii_digit() { while i < b.len() && b[i].is_ascii_digit() { i += 1; } } else { return false; }
    if i < b.len() && b[i] == b'.' { i += 1; let s0 = i; while i < b.len() && b[i].is_ascii_digit() { i += 1; } if i == s0 { return false; } }
    if i < b.len() && (b[i] == b'e' || b[i] == b'E') { i += 1; if i < b.len() && (b[i] == b'+' || b[i] == b'-') { i += 1; } let s0 = i; while i < b.len() && b[i].is_ascii_digit() { i += 1; } if i == s0 { return false; } }
    i == b.len()
}

fn finish_elem(e: Elem, o: &Options) -> Value {
    let text = e.text;
    if e.map.is_empty() {
        if !e.has_text { return Value::Null; }
        return infer(text, o);
    }
    let mut m = e.map;
    if e.has_text { m.insert("#text".into(), infer(text, o)); }
    Value::Object(m)
}

pub fn parse_xml(input: &str, o: &Options) -> Result<Value, ConvError> {
    // XML 1.0 Char production: reject characters that may never appear in a document.
    if let Some((i, ch)) = input.char_indices().find(|&(_, c)| !matches!(c, '\t' | '\n' | '\r' | '\u{20}'..='\u{D7FF}' | '\u{E000}'..='\u{FFFD}' | '\u{10000}'..='\u{10FFFF}')) {
        let (l, c) = line_col(input, i);
        return Err(ConvError::at(format!("Invalid character U+{:04X} (not allowed in XML)", ch as u32), l, c));
    }
    let mut r = Reader::from_str(input);
    r.config_mut().trim_text(false);
    r.config_mut().check_end_names = true;
    let mut stack: Vec<Elem> = vec![];
    let mut root: Option<(String, Value)> = None;
    let err = |r: &Reader<&[u8]>, msg: String, pos: Option<u64>| {
        let (l, c) = line_col(input, pos.unwrap_or(r.buffer_position()) as usize);
        ConvError::at(msg, l, c)
    };
    let start_elem = |r: &Reader<&[u8]>, e: &quick_xml::events::BytesStart, pos: u64| -> Result<Elem, ConvError> {
        let name = String::from_utf8_lossy(e.name().as_ref()).into_owned();
        if !valid_name(&name) { return Err(err(r, format!("Invalid element name '{name}'"), Some(pos + 1))); }
        let mut map = Map::new();
        for a in e.attributes() {
            let a = a.map_err(|x| err(r, format!("Invalid attribute: {x}"), None))?;
            let an = String::from_utf8_lossy(a.key.as_ref()).into_owned();
            if !valid_name(&an) { return Err(err(r, format!("Invalid attribute name '{an}'"), Some(pos))); }
            let k = format!("@{an}");
            let v = a.unescape_value().map_err(|x| err(r, format!("Invalid attribute value: {x}"), None))?.into_owned();
            if map.contains_key(&k) { return Err(err(r, format!("Duplicate attribute '{}'", &k[1..]), None)); }
            map.insert(k, Value::String(v));
        }
        Ok(Elem { pos, name, map, text: String::new(), has_text: false })
    };
    loop {
        let before = r.buffer_position();
        let ev = r.read_event().map_err(|e| err(&r, format!("XML error: {e}"), Some(r.error_position())))?;
        match ev {
            Event::Start(e) => {
                if stack.is_empty() && root.is_some() { return Err(err(&r, "Multiple root elements".into(), Some(before))); }
                stack.push(start_elem(&r, &e, before)?);
            }
            Event::Empty(e) => {
                if stack.is_empty() && root.is_some() { return Err(err(&r, "Multiple root elements".into(), Some(before))); }
                let el = start_elem(&r, &e, before)?;
                let name = el.name.clone();
                let v = finish_elem(el, o);
                match stack.last_mut() { Some(p) => add_child(&mut p.map, name, v), None => root = Some((name, v)) }
            }
            Event::End(_) => {
                let el = stack.pop().ok_or_else(|| err(&r, "Unexpected closing tag".into(), Some(before)))?;
                let name = el.name.clone();
                let v = finish_elem(el, o);
                match stack.last_mut() { Some(p) => add_child(&mut p.map, name, v), None => root = Some((name, v)) }
            }
            Event::Text(t) => {
                let s = t.unescape().map_err(|x| err(&r, format!("Invalid text: {x}"), Some(before)))?;
                let trimmed = s.trim_matches(|c: char| c == ' ' || c == '\t' || c == '\n' || c == '\r');
                match stack.last_mut() {
                    Some(p) => if !trimmed.is_empty() { p.text.push_str(trimmed); p.has_text = true; },
                    None => if !trimmed.is_empty() { return Err(err(&r, "Text outside of the root element".into(), Some(before))); },
                }
            }
            Event::CData(c) => {
                let s = String::from_utf8_lossy(&c.into_inner()).into_owned();
                match stack.last_mut() {
                    Some(p) => { p.text.push_str(&s); p.has_text = true; }
                    None => return Err(err(&r, "CDATA outside of the root element".into(), Some(before))),
                }
            }
            Event::Eof => break,
            _ => {} // declaration, comments, processing instructions, doctype
        }
    }
    if let Some(open) = stack.last() { return Err(err(&r, format!("Unclosed element <{}>: missing </{}> before end of input", open.name, open.name), Some(open.pos))); }
    match root {
        Some((n, v)) => { let mut m = Map::new(); m.insert(n, v); Ok(Value::Object(m)) }
        None => Err(ConvError::at("No root element found", 1, 1)),
    }
}

// ---------------------------------------------------------------- JSON -> XML
fn name_start(c: char) -> bool { c.is_alphabetic() || c == '_' || c == ':' }
fn name_char(c: char) -> bool { name_start(c) || c.is_numeric() || c == '-' || c == '.' || c == '\u{b7}' }
pub fn valid_name(s: &str) -> bool {
    let mut it = s.chars();
    match it.next() { Some(c) if name_start(c) => {}, _ => return false }
    it.all(name_char)
}
pub fn sanitize_name(s: &str) -> String {
    let mut out: String = s.chars().map(|c| if name_char(c) { c } else { '_' }).collect();
    if !out.chars().next().map(name_start).unwrap_or(false) { out.insert(0, '_'); }
    out
}
fn check_name(s: &str, o: &Options, path: &str) -> Result<String, ConvError> {
    if valid_name(s) { return Ok(s.to_string()); }
    if o.invalid_names == "error" { return Err(ConvError::new(format!("Invalid XML name '{s}' at {path}"))); }
    Ok(sanitize_name(s))
}
fn escape(s: &str, attr: bool, path: &str) -> Result<String, ConvError> {
    let mut o = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => o.push_str("&amp;"), '<' => o.push_str("&lt;"), '>' => o.push_str("&gt;"),
            '"' if attr => o.push_str("&quot;"),
            '\r' => o.push_str("&#13;"),
            '\n' if attr => o.push_str("&#10;"),
            '\t' if attr => o.push_str("&#9;"),
            c if (c as u32) < 0x20 && c != '\n' && c != '\t' => return Err(ConvError::new(format!("Control character U+{:04X} cannot be represented in XML 1.0 (at {path})", c as u32))),
            '\u{fffe}' | '\u{ffff}' => return Err(ConvError::new(format!("Character U+{:04X} cannot be represented in XML (at {path})", c as u32))),
            c => o.push(c),
        }
    }
    Ok(o)
}
fn prim_text(v: &Value) -> Option<String> {
    match v { Value::String(s) => Some(s.clone()), Value::Number(n) => Some(n.to_string()), Value::Bool(b) => Some(b.to_string()), _ => None }
}

fn write_elem(name: &str, v: &Value, depth: usize, o: &Options, out: &mut String, path: &str) -> Result<(), ConvError> {
    let pad = " ".repeat(depth * o.indent);
    let nl = if o.indent > 0 { "\n" } else { "" };
    let tag = check_name(name, o, path)?;
    match v {
        Value::Array(items) => {
            for (i, it) in items.iter().enumerate() {
                let p = format!("{path}[{i}]");
                if let Value::Array(_) = it {
                    // nested arrays: wrap in an element and emit items as <item>
                    out.push_str(&format!("{pad}<{tag}>{nl}"));
                    write_elem("item", it, depth + 1, o, out, &p)?;
                    out.push_str(&format!("{pad}</{tag}>{nl}"));
                } else {
                    write_elem(name, it, depth, o, out, &p)?;
                }
            }
        }
        Value::Null => out.push_str(&format!("{pad}<{tag}/>{nl}")),
        Value::Object(m) => {
            let mut attrs = String::new();
            let mut text: Option<String> = None;
            let mut children: Vec<(&String, &Value)> = vec![];
            for (k, val) in m {
                if let Some(an) = k.strip_prefix('@') {
                    let an = check_name(an, o, &format!("{path}.{k}"))?;
                    let t = match val { Value::Null => String::new(), x => prim_text(x).ok_or_else(|| ConvError::new(format!("Attribute '{k}' at {path} must be a string, number, boolean or null")))? };
                    attrs.push_str(&format!(" {an}=\"{}\"", escape(&t, true, path)?));
                } else if k == "#text" {
                    text = match val { Value::Null => None, x => Some(prim_text(x).ok_or_else(|| ConvError::new(format!("'#text' at {path} must be a primitive")))?) };
                } else { children.push((k, val)); }
            }
            if children.is_empty() {
                match text {
                    None => out.push_str(&format!("{pad}<{tag}{attrs}/>{nl}")),
                    Some(t) => out.push_str(&format!("{pad}<{tag}{attrs}>{}</{tag}>{nl}", escape(&t, false, path)?)),
                }
            } else {
                out.push_str(&format!("{pad}<{tag}{attrs}>{nl}"));
                if let Some(t) = text { out.push_str(&format!("{pad}{}{}{nl}", " ".repeat(o.indent), escape(&t, false, path)?)); }
                for (k, val) in children { write_elem(k, val, depth + 1, o, out, &format!("{path}.{k}"))?; }
                out.push_str(&format!("{pad}</{tag}>{nl}"));
            }
        }
        other => {
            let t = prim_text(other).unwrap();
            if t.is_empty() { out.push_str(&format!("{pad}<{tag}></{tag}>{nl}")); }
            else { out.push_str(&format!("{pad}<{tag}>{}</{tag}>{nl}", escape(&t, false, path)?)); }
        }
    }
    Ok(())
}

pub fn to_xml(v: &Value, o: &Options) -> Result<String, ConvError> {
    let mut out = String::from("<?xml version=\"1.0\" encoding=\"UTF-8\"?>");
    if o.indent > 0 { out.push('\n'); }
    match v {
        Value::Object(m) if m.len() == 1 && !m.keys().next().unwrap().starts_with('@') && m.keys().next().unwrap() != "#text" && !m.values().next().unwrap().is_array() => {
            let (k, val) = m.iter().next().unwrap();
            write_elem(k, val, 0, o, &mut out, "$")?;
        }
        Value::Array(items) => {
            let wrapper = Value::Object([("item".to_string(), Value::Array(items.clone()))].into_iter().collect());
            write_elem(&o.root_name, if items.is_empty() { &Value::Null } else { &wrapper }, 0, o, &mut out, "$")?;
        }
        Value::Object(_) => write_elem(&o.root_name, v, 0, o, &mut out, "$")?,
        other => {
            let kind = match other { Value::Null => "null", Value::Bool(_) => "boolean", Value::Number(_) => "number", _ => "string" };
            return Err(ConvError::new(format!("JSON → XML: top-level {kind} can't become an XML document; XML needs a root element. Wrap it in an object, e.g. {{\"value\": …}}")));
        }
    }
    Ok(out)
}
