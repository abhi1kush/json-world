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
npm test         # Vitest unit tests (src/lib/json.test.ts)
npm run build    # type-check + production build
npm run deploy   # build and force-push dist/ (with .nojekyll) to gh-pages
```

All document logic lives in `src/lib/json.ts`: an order-preserving parser and serializer with line/column errors, plus pure path operations (get/set/insert/delete/move/rename/add), type conversion, sort, search, unique key naming and paste rules. None of it depends on the UI.
