//! Java `.properties` <-> JSON. See CONVENTIONS.md ("Java .properties").
use crate::{line_col, ConvError, Options};
use serde_json::{Map, Value};
use std::collections::BTreeMap;

// ---------------------------------------------------------------- JSON -> .properties

/// Escape like `java.util.Properties.store`: `\` `=` `:` `#` `!` and \t \n \r \f everywhere, spaces in keys
/// (only leading spaces in values), other control chars as \uXXXX, non-ASCII as \uXXXX when `escape_unicode`.
pub fn escape(s: &str, is_key: bool, escape_unicode: bool) -> String {
    let mut out = String::with_capacity(s.len());
    for (i, ch) in s.chars().enumerate() {
        match ch {
            ' ' if is_key || i == 0 => out.push_str("\\ "),
            '\\' => out.push_str("\\\\"),
            '\t' => out.push_str("\\t"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\x0C' => out.push_str("\\f"),
            '=' | ':' | '#' | '!' => { out.push('\\'); out.push(ch); }
            c if (c as u32) < 0x20 || c == '\x7F' || ((c as u32) > 0x7E && escape_unicode) => {
                let mut buf = [0u16; 2];
                for u in c.encode_utf16(&mut buf) { out.push_str(&format!("\\u{:04X}", u)); }
            }
            c => out.push(c),
        }
    }
    out
}

fn scalar_text(v: &Value) -> String {
    match v {
        Value::Null => String::new(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => n.to_string(),
        Value::String(s) => s.clone(),
        _ => String::new(),
    }
}

fn flatten(prefix: &str, v: &Value, json_path: &str, o: &Options, out: &mut String) -> Result<(), ConvError> {
    match v {
        Value::Object(m) if !m.is_empty() => {
            for (k, child) in m {
                let jp = format!("{json_path}.{k}");
                if k.is_empty() { return Err(ConvError::new(format!("Key '' (empty) at {json_path} can't be written as a .properties key"))); }
                if k.contains('.') || k.contains('[') || k.contains(']') {
                    return Err(ConvError::new(format!("Key '{k}' at {jp} contains '.', '[' or ']', which .properties uses as path separators; rename the key")));
                }
                let p = if prefix.is_empty() { k.clone() } else { format!("{prefix}.{k}") };
                flatten(&p, child, &jp, o, out)?;
            }
        }
        Value::Array(a) if !a.is_empty() => {
            for (i, child) in a.iter().enumerate() { flatten(&format!("{prefix}[{i}]"), child, &format!("{json_path}[{i}]"), o, out)?; }
        }
        // scalars, null, {} and [] all become `key=value` (empty containers and null: `key=`)
        other => {
            out.push_str(&escape(prefix, true, o.escape_unicode));
            out.push('=');
            out.push_str(&escape(&scalar_text(other), false, o.escape_unicode));
            out.push('\n');
        }
    }
    Ok(())
}

pub fn to_properties(v: &Value, o: &Options) -> Result<String, ConvError> {
    match v {
        Value::Object(_) => { let mut out = String::new(); flatten("", v, "$", o, &mut out)?; Ok(out) }
        other => {
            let kind = match other { Value::Null => "null", Value::Bool(_) => "boolean", Value::Number(_) => "number", Value::String(_) => "string", _ => "array" };
            Err(ConvError::new(format!("JSON → Properties: top-level {kind} can't become a .properties file; it needs an object of keys, e.g. {{\"value\": …}}")))
        }
    }
}

// ---------------------------------------------------------------- .properties -> JSON

/// One logical entry with the 1-based position of its key.
#[derive(Debug, Clone)]
pub struct Entry { pub key: String, pub value: String, pub line: usize, pub col: usize }

fn is_ws(c: char) -> bool { c == ' ' || c == '\t' || c == '\x0C' }

/// Logical lines: (text with continuations joined, byte offset of each char in the source).
fn logical_lines(input: &str) -> Vec<Vec<(char, usize)>> {
    // natural lines, terminators \n, \r, \r\n
    let mut nat: Vec<Vec<(char, usize)>> = vec![vec![]];
    let mut it = input.char_indices().peekable();
    while let Some((i, c)) = it.next() {
        match c {
            '\r' => { if let Some(&(_, '\n')) = it.peek() { it.next(); } nat.push(vec![]); }
            '\n' => nat.push(vec![]),
            _ => nat.last_mut().unwrap().push((c, i)),
        }
    }
    let mut out = vec![];
    let mut cur: Vec<(char, usize)> = vec![];
    let mut cont = false;
    for line in nat {
        let start = line.iter().position(|&(c, _)| !is_ws(c)).unwrap_or(line.len());
        let body = &line[start..];
        if !cont {
            if body.is_empty() { continue; }
            if body[0].0 == '#' || body[0].0 == '!' { continue; }
        }
        let trailing = body.iter().rev().take_while(|&&(c, _)| c == '\\').count();
        if trailing % 2 == 1 { cur.extend_from_slice(&body[..body.len() - 1]); cont = true; }
        else { cur.extend_from_slice(body); out.push(std::mem::take(&mut cur)); cont = false; }
    }
    if cont { out.push(cur); } // a trailing backslash at EOF is dropped, like Java
    out
}

fn unescape(chars: &[(char, usize)], input: &str) -> Result<String, ConvError> {
    let mut s = String::new();
    let mut i = 0;
    let mut pending_high: Option<u16> = None;
    let push_unit = |s: &mut String, pending: &mut Option<u16>, u: u16| {
        if (0xD800..0xDC00).contains(&u) { if pending.is_some() { s.push('\u{FFFD}'); } *pending = Some(u); return; }
        if (0xDC00..0xE000).contains(&u) {
            if let Some(h) = pending.take() { s.push(char::from_u32(0x10000 + (((h as u32) - 0xD800) << 10) + ((u as u32) - 0xDC00)).unwrap()); }
            else { s.push('\u{FFFD}'); }
            return;
        }
        if pending.take().is_some() { s.push('\u{FFFD}'); }
        s.push(char::from_u32(u as u32).unwrap());
    };
    while i < chars.len() {
        let (c, off) = chars[i];
        if c != '\\' { if pending_high.take().is_some() { s.push('\u{FFFD}'); } s.push(c); i += 1; continue; }
        i += 1;
        let Some(&(e, _)) = chars.get(i) else { break };
        i += 1;
        match e {
            'u' => {
                let hex: String = chars[i..chars.len().min(i + 4)].iter().map(|&(c, _)| c).collect();
                if hex.len() != 4 || !hex.chars().all(|c| c.is_ascii_hexdigit()) {
                    let (l, col) = line_col(input, off);
                    return Err(ConvError::at(format!("Malformed \\uXXXX escape: expected 4 hex digits after \\u, found '{hex}'"), l, col));
                }
                push_unit(&mut s, &mut pending_high, u16::from_str_radix(&hex, 16).unwrap());
                i += 4;
            }
            _ => {
                if pending_high.take().is_some() { s.push('\u{FFFD}'); }
                s.push(match e { 't' => '\t', 'n' => '\n', 'r' => '\r', 'f' => '\x0C', other => other });
            }
        }
    }
    if pending_high.is_some() { s.push('\u{FFFD}'); }
    Ok(s)
}

/// Parse with `java.util.Properties.load` semantics (comments, continuation lines, `=`/`:`/whitespace separators).
pub fn parse_entries(input: &str) -> Result<Vec<Entry>, ConvError> {
    let mut out = vec![];
    for ll in logical_lines(input) {
        // key ends at the first unescaped '=', ':' or whitespace
        let mut k = 0;
        while k < ll.len() {
            let c = ll[k].0;
            if c == '\\' { k += 2; continue; }
            if c == '=' || c == ':' || is_ws(c) { break; }
            k += 1;
        }
        let k = k.min(ll.len());
        let mut v = k;
        while v < ll.len() && is_ws(ll[v].0) { v += 1; }
        if v < ll.len() && (ll[v].0 == '=' || ll[v].0 == ':') { v += 1; while v < ll.len() && is_ws(ll[v].0) { v += 1; } }
        let (line, col) = line_col(input, ll[0].1);
        out.push(Entry { key: unescape(&ll[..k], input)?, value: unescape(&ll[v..], input)?, line, col });
    }
    Ok(out)
}

#[derive(Debug, Clone, PartialEq)]
enum Seg { Key(String), Idx(usize) }

fn segments(e: &Entry) -> Result<Vec<Seg>, ConvError> {
    let bad = |m: String| ConvError::at(format!("Invalid key '{}': {m}", e.key), e.line, e.col);
    if e.key.is_empty() { return Err(bad("empty key".into())); }
    let mut segs = vec![];
    for part in e.key.split('.') {
        let (name, rest) = match part.find('[') { Some(i) => (&part[..i], &part[i..]), None => (part, "") };
        if name.is_empty() { return Err(bad("empty path segment (check for '..' or a leading/trailing '.')".into())); }
        if name.contains(']') { return Err(bad(format!("unexpected ']' in '{part}'"))); }
        if !name.is_empty() { segs.push(Seg::Key(name.to_string())); }
        let mut r = rest;
        while !r.is_empty() {
            let close = r.find(']').ok_or_else(|| bad(format!("missing ']' in '{part}'")))?;
            let inner = &r[1..close];
            if inner.is_empty() || !inner.chars().all(|c| c.is_ascii_digit()) { return Err(bad(format!("array index '[{inner}]' must be a non-negative integer"))); }
            if inner.len() > 1 && inner.starts_with('0') { return Err(bad(format!("array index '[{inner}]' has a leading zero"))); }
            let n: usize = inner.parse().map_err(|_| bad(format!("array index '[{inner}]' is too large")))?;
            if n > 100_000 { return Err(bad(format!("array index [{n}] is too large (max 100000)"))); }
            segs.push(Seg::Idx(n));
            r = &r[close + 1..];
            if !r.is_empty() && !r.starts_with('[') { return Err(bad(format!("unexpected text after ']' in '{part}'"))); }
        }
    }
    Ok(segs)
}

enum Node { Leaf { v: String, at: (usize, usize, String) }, Obj { m: Vec<(String, Node)>, at: (usize, usize, String) }, Arr { m: BTreeMap<usize, Node>, at: (usize, usize, String) } }
impl Node {
    fn at(&self) -> &(usize, usize, String) { match self { Node::Leaf { at, .. } | Node::Obj { at, .. } | Node::Arr { at, .. } => at } }
    fn kind(&self) -> &'static str { match self { Node::Leaf { .. } => "a value", Node::Obj { .. } => "an object (has '.child' keys)", Node::Arr { .. } => "an array (has '[n]' keys)" } }
}
fn path_str(segs: &[Seg]) -> String {
    let mut s = String::new();
    for g in segs { match g { Seg::Key(k) => { if !s.is_empty() { s.push('.'); } s.push_str(k); } Seg::Idx(i) => s.push_str(&format!("[{i}]")) } }
    s
}

fn insert(node: &mut Node, segs: &[Seg], depth: usize, e: &Entry) -> Result<(), ConvError> {
    let here = path_str(&segs[..depth]);
    let want_kind = |s: &Seg| -> Node { let at = (e.line, e.col, here.clone()); match s { Seg::Key(_) => Node::Obj { m: vec![], at }, Seg::Idx(_) => Node::Arr { m: BTreeMap::new(), at } } };
    let conflict = |existing: &Node, new_kind: &str| {
        let (l, c, p) = existing.at();
        ConvError::at(format!("Conflicting keys: '{}' needs '{}' to be {new_kind}, but line {l}, column {c} already makes '{p}' {}", e.key, here, existing.kind()), e.line, e.col)
    };
    let seg = &segs[depth];
    let last = depth + 1 == segs.len();
    let child: &mut Node = match (node, seg) {
        (Node::Obj { m, .. }, Seg::Key(k)) => {
            if let Some(i) = m.iter().position(|(n, _)| n == k) { &mut m[i].1 }
            else {
                let fresh = if last { Node::Leaf { v: String::new(), at: (e.line, e.col, e.key.clone()) } } else { want_kind(&segs[depth + 1]) };
                m.push((k.clone(), fresh)); &mut m.last_mut().unwrap().1
            }
        }
        (Node::Arr { m, .. }, Seg::Idx(i)) => m.entry(*i).or_insert_with(|| if last { Node::Leaf { v: String::new(), at: (e.line, e.col, e.key.clone()) } } else { want_kind(&segs[depth + 1]) }),
        (n, Seg::Key(_)) => return Err(conflict(n, "an object")),
        (n, Seg::Idx(_)) => return Err(conflict(n, "an array")),
    };
    let here2 = path_str(&segs[..=depth]);
    if last {
        match child {
            Node::Leaf { v, at } => { *v = e.value.clone(); *at = (e.line, e.col, e.key.clone()); Ok(()) } // duplicate key: last wins (like Java)
            other => { let (l, c, _) = other.at(); Err(ConvError::at(format!("Conflicting keys: '{}' is a value, but line {l}, column {c} already makes '{here2}' {}", e.key, other.kind()), e.line, e.col)) }
        }
    } else {
        if let Node::Leaf { at: (l, c, _), .. } = child {
            return Err(ConvError::at(format!("Conflicting keys: '{}' needs '{here2}' to have children, but line {l}, column {c} already sets '{here2}' to a value", e.key), e.line, e.col));
        }
        insert(child, segs, depth + 1, e)
    }
}

fn to_value(n: Node, o: &Options) -> Result<Value, ConvError> {
    Ok(match n {
        Node::Leaf { v, .. } => crate::xml::infer(v, o),
        Node::Obj { m, .. } => { let mut out = Map::new(); for (k, c) in m { out.insert(k, to_value(c, o)?); } Value::Object(out) }
        Node::Arr { m, at } => {
            let mut out = vec![];
            for (expected, (i, c)) in m.into_iter().enumerate() {
                if i != expected {
                    let (l, col, _) = c.at().clone();
                    return Err(ConvError::at(format!("Array '{}' has no element [{expected}] but has [{i}]; indexes must be contiguous from 0", at.2), l, col));
                }
                out.push(to_value(c, o)?);
            }
            Value::Array(out)
        }
    })
}

pub fn parse_properties(input: &str, o: &Options) -> Result<Value, ConvError> {
    let mut root = Node::Obj { m: vec![], at: (1, 1, String::new()) };
    for e in parse_entries(input)? {
        let segs = segments(&e)?;
        if let Seg::Idx(_) = segs[0] { return Err(ConvError::at(format!("Invalid key '{}': a key can't start with '['", e.key), e.line, e.col)); }
        insert(&mut root, &segs, 0, &e)?;
    }
    to_value(root, o)
}
