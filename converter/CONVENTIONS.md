# Conversion conventions

All conversions go through a JSON value. Key order is kept everywhere, and numbers are kept as exact decimal text, so big integers never lose precision. Exponents may be written in a normalised form, e.g. `1e3` becomes `1e+3`.

## YAML (YAML 1.2 core schema)

| YAML | JSON |
| --- | --- |
| `null`, `Null`, `NULL`, `~`, empty | `null` |
| `true`/`True`/`TRUE`, `false`/… | boolean |
| `123`, `-7`, `+7`, `007`, `0x1F`, `0o17` | number (`007` → `7`, hex/octal → decimal) |
| `1.5`, `.5`, `1e3` | number (`.5` → `0.5`) |
| `yes`, `no`, `on`, `off` | **strings** (these are YAML 1.1 booleans, not YAML 1.2) |
| `.inf`, `.nan` | **error**: JSON can't represent them |
| quoted scalars, `!!str` | string |
| integers of any size | exact number |

- **Key order** is preserved. Keys keep their literal text: `1: x` becomes `{"1": "x"}`. Complex (mapping/sequence) keys are an error. Duplicate keys are an error.
- **Anchors and aliases** are resolved by copying the anchored value. **Merge keys** (`<<: *a` or `<<: [*a, *b]`) are supported. Explicit keys override merged keys, and merged keys sit where the `<<` was.
- **Multiple documents** (`---`): with the default `multiDoc: "array"` they become a JSON array with one element per document. With `multiDoc: "error"` they are rejected. An empty stream gives `null`.
- Tags other than the standard `!!str/!!int/!!float/!!bool/!!null` are ignored.
- **JSON → YAML** writes block style. A string is left plain only when it can't be read back as anything else. Otherwise it is double-quoted with escapes, e.g. `"true"`, `"123"`, `""`, `"a: b"`, or text with newlines or non-ASCII. Empty containers are written `{}` / `[]`.
- Errors report line and column (1-based).

## XML

### XML → JSON

| XML | JSON |
| --- | --- |
| root element `<r>…</r>` | `{"r": …}`: the result is always a one-key object named after the root |
| attribute `a="1"` | `"@a": "1"` |
| text only, `<a>hi</a>` | `"a": "hi"` |
| text plus attributes or children | `"#text": "hi"` |
| repeated sibling elements `<i/><i/>` | `"i": [ … ]`; a single element stays a scalar or object |
| empty element `<e/>` or `<e></e>` | `"e": null` |
| `<![CDATA[ … ]]>` | text, kept verbatim and merged into the element's text |
| namespaces | names kept as written: `"soap:Body"`, `"@xmlns:soap"` |
| comments, processing instructions, XML declaration, DOCTYPE | ignored |

- Leading and trailing whitespace of text nodes is trimmed, and whitespace-only text is dropped. In mixed content all text pieces are joined into one `#text`, so the position of text relative to child elements is lost.
- Values are strings unless **`inferTypes`** is on. Then `true`/`false` become booleans and text that is a valid JSON number becomes a number (`012` stays a string).
- Entities (`&amp;`, `&#65;`, `&#x41;`) are decoded. Errors (mismatched tags, multiple roots, duplicate attributes, unclosed elements) report line and column.

### JSON → XML

- **Root:** a one-key object (whose key isn't `@…`/`#text` and whose value isn't an array) becomes the root element. Anything else is wrapped in `rootName` (default `root`): arrays become `<root><item>…</item>…</root>`, and multi-key objects go inside `<root>`. A top-level primitive (number, string, boolean, null) is an **error**, because XML needs a root element.
- `"@x"` keys become attributes (strings, numbers, booleans or null only). `"#text"` becomes text content, and other keys become child elements.
- An array under key `k` becomes repeated `<k>` elements. Nested arrays are wrapped as `<k><item>…</item></k>`.
- `null` becomes `<k/>`, `""` becomes `<k></k>`, and numbers and booleans become their text.
- **Invalid names** (e.g. `1st`, `a b`, `""`): with `invalidNames: "sanitize"` (default), invalid characters become `_` and a `_` is added in front when the first character isn't allowed (`1st` → `_1st`, `a b` → `a_b`, `""` → `_`). With `invalidNames: "error"` the conversion fails and the error names the path.
- Text is escaped (`&`, `<`, `>`, plus `"` and newlines/tabs in attributes; `\r` becomes `&#13;`). Control characters that XML 1.0 can't represent cause an error.

### Round-trip guarantee

`JSON → XML → JSON` gives back the identical JSON when the JSON already follows the convention. That means:
- leaves are `null` or non-empty strings with no leading or trailing whitespace (with `inferTypes`, booleans and numbers also work, as long as no string looks like a number or boolean);
- arrays have at least 2 items and contain no arrays;
- names are valid XML names;
- text sits only in `#text` next to attributes or children.

Things that can't round-trip: `""` (comes back as `null`), single-item and empty arrays, nested arrays, and numbers without `inferTypes`. Property tests in `tests/props.rs` and `src/lib/convert.test.ts` check all of this.

## Java .properties

### JSON → Properties

- The top level must be an object (a scalar or array is an error: a `.properties` file is a set of keys).
- Nested keys are joined with `.`, and array elements use Spring Boot indexes: `{"a":{"b":[1,{"c":2}]}}` → `a.b[0]=1`, `a.b[1].c=2`. Nested arrays give `m[0][1]`.
- Values are written as strings: numbers keep their exact text, booleans become `true`/`false`.
- `null`, `{}` and `[]` are all written as `key=` (empty value). They can't be told apart when reading back, so they all come back as `""`.
- Escaping follows `java.util.Properties.store`: `\` `=` `:` `#` `!` are backslash-escaped in keys and values, spaces are escaped everywhere in keys but only when leading in values, tab/newline/CR/form feed become `\t` `\n` `\r` `\f`, and other control characters become `\uXXXX`. With **Escape non-ASCII** (`escapeUnicode`, default on) every character above `~` is written as `\uXXXX` (UTF-16 surrogate pairs for emoji), so the file is pure ASCII and loads with `Properties.load(InputStream)`. With it off, the output is UTF-8 and needs `Properties.load(Reader)` (or Java 9+ resource bundles).
- A JSON key containing `.`, `[` or `]`, or an empty key, is an error because it can't be represented unambiguously.

### Properties → JSON

- Parsing follows `Properties.load`: `#`/`!` comment lines, blank lines, continuation lines (odd number of trailing `\`, leading whitespace of the next line dropped), and `=`, `:` or whitespace as the key/value separator. `\t \n \r \f \uXXXX` escapes are decoded; any other `\c` is `c`. A malformed `\u` escape is an error (as in Java).
- Keys are split on `.` and `[n]` and rebuilt into objects and arrays (key order = first appearance). Indexes must be contiguous from 0 and written without leading zeros.
- Duplicate keys: the last one wins (as in Java).
- Conflicts such as `a=1` together with `a.b=2`, or `a[0]` together with `a.x`, are errors reported at the later line and column, naming the earlier line.
- Values are strings. With **Infer numbers/booleans** (`inferTypes`), `true`/`false` and JSON-number text become booleans and exact numbers (`007` stays a string). Empty values stay `""`.
