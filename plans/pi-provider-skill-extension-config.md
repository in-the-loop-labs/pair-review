# Pi Provider: `load_skills` and `app_extensions` Config Fields

## Context

Skills configured in the user's environment (auto-discovered by Pi CLI) can interfere with code review — the worst offenders attempt fixes and dirty the worktree. Currently, the only way to disable skills is via `extra_args: ["--no-skills"]` in provider config, which is obscure and undiscoverable. Similarly, when developing pair-review itself, Pi's auto-discovery of extensions conflicts with pair-review's explicit `-e` flag, loading the task extension twice.

This change adds two first-class boolean config fields on the Pi provider to replace these `extra_args` workarounds.

## Changes

### 1. Pass new fields through config overrides

**`src/ai/provider.js`** — `applyConfigOverrides()` (lines 554-561)

Add `load_skills` and `app_extensions` to the stored overrides object in both the standard override path and the alias path:

```javascript
// Standard path (line 555)
providerConfigOverrides.set(providerId, {
  command: providerConfig.command,
  installInstructions: providerConfig.installInstructions,
  extra_args: providerConfig.extra_args,
  env: providerConfig.env,
  models: processedModels,
  load_skills: providerConfig.load_skills,
  app_extensions: providerConfig.app_extensions,
});

// Alias path (line 530) — same addition
```

### 2. Apply fields in Pi analysis provider

**`src/ai/pi-provider.js`** — constructor (lines 203-213)

Read both fields from `configOverrides`, defaulting to `true`:

```javascript
const loadSkills = configOverrides.load_skills !== false;
const appExtensions = configOverrides.app_extensions !== false;
```

- When `loadSkills` is false: prepend `--no-skills` to baseArgs
- When `appExtensions` is false: omit `-e TASK_EXTENSION_DIR` from baseArgs

Update the baseArgs construction (both yolo and non-yolo branches):
- Conditionally include `-e`, `TASK_EXTENSION_DIR` only when `appExtensions` is true
- Add `--no-skills` when `loadSkills` is false

Also update the comment block (lines 199-202) to reference the new fields instead of `extra_args`.

### 3. Pass fields through chat provider config

**`src/chat/chat-providers.js`** — `getChatProvider()` (lines 103-150)

Pass through `load_skills` and `app_extensions` from chat_providers config overrides, in both the dynamic provider path (line 110-127) and the merge path (line 130-149):

```javascript
// Dynamic provider path
if (overrides.load_skills !== undefined) provider.load_skills = overrides.load_skills;
if (overrides.app_extensions !== undefined) provider.app_extensions = overrides.app_extensions;

// Merge path
if (overrides.load_skills !== undefined) merged.load_skills = overrides.load_skills;
if (overrides.app_extensions !== undefined) merged.app_extensions = overrides.app_extensions;
```

### 4. Support `loadSkills` in PiBridge

**`src/chat/pi-bridge.js`**

- Add `loadSkills` option to constructor (default `true`), store as `this.loadSkills`
- In `_buildArgs()`: when `this.loadSkills` is false, add `--no-skills` to the args (before extraArgs)

`app_extensions` does NOT go on PiBridge — the caller (session-manager) decides which extensions to pass based on the config. PiBridge just processes whatever extensions it receives.

### 5. Apply fields in Pi chat bridge creation

**`src/chat/session-manager.js`** — `_createBridge()` (lines 577-589)

Read `load_skills` and `app_extensions` from the chat provider definition (returned by `getChatProvider()`):

```javascript
const appExtensions = def?.app_extensions !== false;
return new PiBridge({
  ...options,
  // ... existing fields ...
  extensions: appExtensions ? [taskExtensionDir] : [],
  loadSkills: def?.load_skills,
});
```

### 5. Update config example

**`config/config.example.json`** — Pi provider section

Add documented examples:
```json
{
  "pi": {
    "load_skills": true,
    "app_extensions": true,
    "extra_args": [],
    ...
  }
}
```

With comments explaining the fields.

### 6. Update project config

**`.pair-review/config.json`**

Replace the current `extra_args: ["--no-skills"]` with the new field:
```json
{
  "providers": {
    "pi": { "load_skills": false }
  }
}
```

## Hazards

- `applyConfigOverrides()` has three code paths (executable, alias, standard). The new fields only apply to alias and standard paths — executable providers have their own class and wouldn't use Pi-specific flags.
- `buildArgsForModel()` (extraction, line 711) and `getExtractionConfig()` (line 732) do NOT include the task extension or skills — no changes needed there.
- PiBridge's `_buildArgs()` appends extraArgs last (line 293-297). Adding `--no-skills` before extraArgs lets `extra_args` in chat_providers config still override if needed.
- Built-in model `--skill <path>` args (multi-model, review-roulette) come from `builtInArgs` which are appended after baseArgs. `--no-skills` disables auto-discovery while explicit `--skill` still loads — no conflict.

## Tests

### `tests/unit/pi-provider.test.js`
- `load_skills: false` adds `--no-skills` to baseArgs
- `load_skills: true` (and default/undefined) does NOT add `--no-skills`
- `app_extensions: false` omits `-e TASK_EXTENSION_DIR` from baseArgs
- `app_extensions: true` (and default/undefined) includes `-e TASK_EXTENSION_DIR`
- Both fields combined: `load_skills: false, app_extensions: false`

### `tests/unit/chat/pi-bridge.test.js`
- `loadSkills: false` adds `--no-skills` to built args
- `loadSkills: true` (and default) does not
- Constructor stores the option

### `tests/unit/chat/session-manager.test.js`
- When Pi chat provider has `app_extensions: false`, PiBridge receives empty extensions array
- When Pi chat provider has `load_skills: false`, PiBridge receives `loadSkills: false`
- Default behavior unchanged (extensions: [taskExtensionDir], loadSkills not set)

### `tests/unit/chat/chat-providers.test.js` (if exists)
- `load_skills` and `app_extensions` are passed through in getChatProvider merge

### `tests/unit/provider-config.test.js`
- `load_skills` and `app_extensions` are stored in providerConfigOverrides
- Fields are stored for alias providers too

## Verification

1. Run `npm test` — all unit/integration tests pass
2. Run `npm run test:e2e` — E2E tests pass
3. Manual: configure `.pair-review/config.json` with `load_skills: false` on Pi, run analysis, verify `--no-skills` appears in the spawned command (visible in debug logs)
