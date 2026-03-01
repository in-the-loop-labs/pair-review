# Plan: Add `config.local.json` Support

## Context

`config.json` can be checked into a project or installed by company tooling, but users need a way to override settings personally. Adding `config.local.json` (gitignored) at both the global and project levels solves this. The current merge logic is also only one-level deep and duplicated — this refactor replaces it with a proper recursive `deepMerge`.

## Precedence (lowest → highest)

1. `DEFAULT_CONFIG` (built-in)
2. `~/.pair-review/config.json`
3. `~/.pair-review/config.local.json`
4. `./.pair-review/config.json`
5. `./.pair-review/config.local.json`
6. In-app/database (already separate, no changes)

## Files to Modify

- `src/config.js` — add `deepMerge`, refactor `loadConfig()`, export `deepMerge`
- `tests/unit/config.test.js` — update `mockReadFile` helper, add `deepMerge` tests, add 4-layer precedence tests
- `README.md` — document layered config and `config.local.json` purpose

## Implementation

### 1. Add `deepMerge(target, source)` to `src/config.js`

Recursive merge of plain objects. Arrays and scalars are replaced (not concatenated). Null in source overwrites. Returns new object, never mutates inputs.

### 2. Refactor `loadConfig()` to a sources-loop pattern

```javascript
const sources = [
  { path: CONFIG_FILE,                              label: 'global config',        required: true  },
  { path: path.join(CONFIG_DIR, 'config.local.json'), label: 'global local config', required: false },
  { path: path.join(localDir, 'config.json'),       label: 'project config',       required: false },
  { path: path.join(localDir, 'config.local.json'), label: 'project local config', required: false },
];

let mergedConfig = { ...DEFAULT_CONFIG };
for (const source of sources) {
  // read, parse, deepMerge onto mergedConfig
  // error handling per source (see below)
}
```

### 3. Error handling per file

| File | ENOENT | SyntaxError | Other |
|------|--------|-------------|-------|
| `~/.pair-review/config.json` (required) | Create defaults, return `isFirstRun: true` | `process.exit(1)` | `throw` |
| All other files (not required) | Skip silently | `logger.warn()`, skip | `throw` |

### 4. Tests

**New `deepMerge` tests:** scalar override, new key addition, nested merge, 3-level deep, array replacement, null overwrites, undefined/empty source no-op, immutability check.

**Update `mockReadFile`:** Accept `{ global, globalLocal, project, projectLocal }` object instead of positional args. Update all existing tests to new signature.

**New `loadConfig` tests:** global-local overrides global, project-local overrides project, full 4-layer precedence, deep merge across layers for nested objects (providers, chat), malformed local files warn and skip, missing local files skip silently.

### 5. README update

Add a "Configuration Files" section documenting the 4-file precedence table and advising users to gitignore `config.local.json`.

### 6. Changeset

`minor` — new feature: layered config with `config.local.json` support.

## Verification

1. `npm test` — all unit/integration tests pass
2. `npm run test:e2e` — E2E tests pass (config loading is on the startup path)
