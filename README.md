# JSON World

A fast, correct JSON viewer & editor: a CodeMirror 6 text editor on the left, an editable collapsible tree on the right, kept in two-way sync.

**Live:** https://abhi1kush.github.io/json-world/

## Features

- **Two-way real-time sync** – typing valid JSON updates the tree (150 ms debounce). Invalid JSON shows the error with line/column (status bar + inline lint) while the tree keeps the last valid document. Any tree edit rewrites the text immediately, pretty-printed with indent 2 or 4.
- **Text editor** – CodeMirror 6 with JSON syntax highlighting, linting, line numbers, folding and bracket matching.
- **Tree view** – expand/collapse per node, Expand all / Collapse all, type badges, child counts, colored keys and values. Virtualized rows, so multi-MB documents stay responsive.
- **Inline editing** – double-click a key to rename it, or a value to edit it. Values are parsed as JSON literals (`42`, `true`, `null`, `{"a":1}`, `[1,2]`, `"quoted"`); anything that isn't valid JSON is stored as a string. Change type, add child/sibling, delete, and move array items up/down.
- **Copy / paste nodes** – copy any node (collapsed ones too, with the whole subtree) to the system clipboard as JSON, with an internal clipboard as a fallback. Paste rules:
  - selected **object** → added as a new key (`key`, then `key_copy`, `key_copy2`, …; or *Paste as key…* to type a name)
  - selected **array** → appended
  - selected item **inside an array** → inserted after it
  - selected primitive **inside an object** → inserted after it as a sibling with a unique key
  - *Paste (replace value)* → replaces the selected node
- **Undo / redo** across both panels (Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z or Ctrl+Y).
- **Toolbar** – Format, Minify, Sort keys (deep), indent 2/4, Load file, Download, Sample, search/filter on keys and values with highlighting, and the selected node's path (e.g. `$.users[2].name`) with Copy path.
- **Faithful model** – key order is kept exactly as written, integer-like keys included (`{"b":1,"10":2}` is not reordered), and number text is kept as written (big integers don't lose precision).
- Draggable splitter. On phones the panels stack vertically.

## Saved data

Everything you enter is saved in this browser's `localStorage` and nothing is sent anywhere. That covers the Viewer text, indent and expanded/collapsed nodes; the Convert input, formats and options; the Compare inputs and toggles; the JSON → Java input and all its options; and the active tab. Data is restored before the first render, and samples are shown only when nothing is saved.
- Keys are versioned (`jsonworld:v1:*`). Saves are debounced (300 ms) and flushed on `visibilitychange`, `pagehide` and `beforeunload`. With several tabs open, the last write wins.
- Corrupted, invalid or old-version data is ignored field by field, falling back to defaults.
- If a value is too big for the browser quota (e.g. >5 MB), it stays in memory for the session, any older saved copy is removed, and a small "too large to save locally" notice appears. If storage is disabled (some private modes), the app still works and says data won't be kept.
- **Clear saved data** (top right, asks for confirmation) removes every `jsonworld:*` key and reloads with the samples.

## Tabs

The app has four tabs: **Viewer**, **Convert**, **Compare** and **JSON → Java**. The URL hash (`#convert`, `#compare`, `#java`) selects one, and every tab keeps its state when you switch away.

### Convert (Rust → WebAssembly)

- Converts between JSON, YAML and XML in any direction (JSON↔YAML, JSON↔XML, and YAML↔XML through JSON). The converter is written in Rust (`converter/`, using serde_json with `preserve_order` + `arbitrary_precision`, yaml-rust2 and quick-xml) and compiled with wasm-pack. The WASM file is downloaded only when you first open the Convert tab.
- Input and output panes with format pickers and a **Swap** button. Options: XML root name, how to handle invalid XML names, inferring numbers/booleans from XML, how to handle multi-document YAML, and indent.
- Upload a file (the format is detected from its extension or content), download with the right extension, copy, and **Send to Viewer**. Errors show line and column.
- The mapping rules (`@attr`, `#text`, repeated elements → arrays, root handling, namespaces, CDATA, empty elements, YAML schema, anchors, multi-docs, big ints) are documented in [`converter/CONVENTIONS.md`](converter/CONVENTIONS.md).

### Compare

- Two JSON inputs: paste, upload, or **Use viewer JSON**.
- **Arrays are sorted before comparing (default).** Both inputs are normalized bottom-up: arrays nested deeper are sorted first, then each array's elements are stably sorted by the canonical JSON string of the already-normalized element. In that string object keys are sorted by code point and numbers keep their exact text, so `10` sorts before `9`. Objects keep their own key order. The sorted arrays are then aligned with an LCS (Myers) diff over the elements' canonical strings, so equal elements match each other and a missing or extra element shows up as a single removal or addition, with no knock-on changes for the elements after it. Between two matched elements, leftover elements of the same type are paired by structural similarity (shared keys, equal values) and shown as *changed*, with the detail inside them. Whatever is still unpaired is shown as added or removed. This applies to both the tree diff and the text diff (the text diff shows the sorted versions), and the summary shows an "Arrays sorted" note. Turn on **Check order differences** (off by default) to skip sorting and alignment and compare arrays strictly by index, so reordered elements show up as differences. There is no match-by-key option in the UI. (`diff()` in `src/lib/diff.ts` still accepts `arrayKey` for programmatic use.)
- A semantic diff. Object key order is ignored by default (toggle to report reordering). Numbers are compared by exact value (`1` = `1.0` = `1e0`), and `null` is not treated the same as a missing key.
- Side-by-side collapsible trees: added rows are green, removed red, changed amber. Paths with differences open automatically, collapsed nodes show a diff-count badge, and there's next/prev navigation, summary counts and an "only show differences" toggle.
- A line-based **text diff** of the pretty-printed documents (keys sorted when key order is ignored), side by side with synced scrolling.

### JSON → Java

Turns a JSON request into a Jackson-annotated Java value object, updating as you type.
- **Structure:** one public top-level class (class name and optional package are configurable). Every nested object becomes a `public static class` inside it. Array element classes get singular names (`items` → `Item`, `categories` → `Category`, `people` → `Person`). Name clashes are resolved (`User`, `User2`), JDK names aren't shadowed, and identical shapes can share one class (option).
- **Field names:** private fields with `@JsonProperty("originalKey")`, named in camelCase. snake/kebab/space keys are converted, a leading digit gets a `field` prefix (`1st` → `field1st`), Java keywords get a `Value` suffix (`class` → `classValue`), and names that collide after cleanup get a number (`userName2`).
- **Types:** `String`, `Boolean`, `Integer` → `Long` (outside int range) → `BigInteger` (outside long range), `Double` (or `BigDecimal`), `null` → `Object` unless another sample gives a type. `List<T>` gets its element type by merging all elements (mixed → `List<Object>`, empty → `List<Object>`, nested → `List<List<T>>`). Arrays of objects merge keys into one class, and keys missing from some elements become nullable fields. An empty object becomes `Map<String, Object>`. A top-level array generates the class from its merged element.
- **Styles:** **Lombok is the default** (`@Data @NoArgsConstructor @AllArgsConstructor`, optional `@Builder`, no hand-written getters/setters). You can also pick a plain class (constructors, plus opt-in getters/setters and toString/equals/hashCode) or Java records (nested records). Options: primitives (only for fields that are never null), BigDecimal, `@JsonIgnoreProperties(ignoreUnknown = true)`, `@JsonInclude(NON_NULL)`.
- **Jackson naming fix:** when an accessor name would make Jackson see a different property than the field, e.g. `getAB()` → `ab`, the getter and setter get `@JsonProperty` in plain mode, and the class gets field-only `@JsonAutoDetect` in Lombok mode.
- **Output:** copy, or download as `<ClassName>.java`.
- **Verification:** `npm run verify:java` (`scripts/verify-java.sh`) generates code for the samples in `scripts/java-verify/samples` in 7 option sets (plain, Lombok, record). It compiles everything with a real `javac` against jackson-annotations/databind and Lombok downloaded from Maven Central, then round-trips each sample through `ObjectMapper` and compares the JSON trees. It is not run in CI.

## Keyboard (tree focused)

| Key | Action |
| --- | --- |
| ↑ / ↓ | Select previous / next row |
| ← / → | Collapse / expand (or go to parent / first child) |
| Enter | Edit value |
| F2 | Rename key |
| Delete / Backspace | Delete node |
| Ctrl/Cmd+C, Ctrl/Cmd+V | Copy / paste node |
| Alt+↑ / Alt+↓ | Move array item |
| Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z | Undo / redo |

Right-click a node for the context menu, which has the same actions.

## Development

```bash
npm install
npm run dev      # dev server
npm test         # Vitest: json model, diff, and WASM converter integration/property tests
npm run verify:java # javac + Jackson round-trip check of generated Java (needs JDK 17+)
npm run test:rust   # Rust unit + proptest tests (converter/)
npm run build:wasm  # rebuild converter/pkg (needs rustup target wasm32-unknown-unknown + wasm-pack)
npm run build    # type-check + production build
npm run deploy   # rebuild WASM if wasm-pack exists, build, force-push dist/ (with .nojekyll) to gh-pages
```

All document logic lives in `src/lib/json.ts`: an order-preserving parser and serializer with line/column errors, plus pure path operations (get/set/insert/delete/move/rename/add), type conversion, sort, search, unique key naming and paste rules. None of it depends on the UI. The diff logic is in `src/lib/diff.ts`, and the generated WASM package `converter/pkg` is committed, so the site builds without Rust.
