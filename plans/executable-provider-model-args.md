# Executable Provider: Model cli_model and extra_args Support

## Context

Executable providers support model "variants" (e.g., Binks with `default`, `opus-4-6`, `no-critic`) but the constructor ignores model-level `cli_model` and `extra_args`. This means:
- `executableContext.model` passes the raw model ID (e.g., `opus-4-6`) instead of the resolved CLI model name (`anthropic:claude-opus-4-6`)
- Model-level `extra_args` (e.g., `["--critic-models", "DISABLED"]`) are never forwarded to the tool

## Hazards

- `_buildArgs` is called from `execute` (one caller, line ~184). Safe to change.
- `executableContext.model` is set in `runExecutableVoice` (analyzer.js line 134) from `voiceProvider.model`. The base `AIProvider` sets `this.model` in constructor — we need a separate resolved property.
- `_buildArgs` checks `value != null` to skip null/undefined context values, but empty string `""` would still pass through. Need to handle `cli_model: ""` as "suppress model".

## Changes

### 1. Resolve model config in constructor (`src/ai/executable-provider.js`)

In the constructor (after `super(model)`), look up the current model from the `models` array (available via closure) and resolve `cli_model` and `extra_args`:

```javascript
constructor(model = 'default', configOverrides = {}) {
  super(model);

  // ... existing command resolution ...

  // Resolve model-level config from the models array
  const modelConfig = models.find(m => m.id === model) || {};
  this.resolvedModel = modelConfig.cli_model !== undefined ? modelConfig.cli_model : model;
  this.modelExtraArgs = modelConfig.extra_args || [];

  this.baseArgs = config.args || [];
  // ...existing fields...
  this.providerExtraArgs = [
    ...(config.extra_args || []),
    ...(configOverrides.extra_args || [])
  ];
  this.extraEnv = {
    ...(config.env || {}),
    ...(configOverrides.env || {}),
    ...(modelConfig.env || {})
  };
}
```

- `resolvedModel`: `cli_model` if defined (even `""`), else model `id`
- `modelExtraArgs`: model-level extra args
- `providerExtraArgs`: provider-level extra args (from config + configOverrides)
- `extraEnv`: three-way merge (config + configOverrides + model)

### 2. Apply extra_args in `_buildArgs` (`src/ai/executable-provider.js`)

Append provider and model extra_args after base args, before context args:

```javascript
_buildArgs(executableContext) {
  const args = [...this.baseArgs, ...this.providerExtraArgs, ...this.modelExtraArgs];

  for (const [configKey, flag] of Object.entries(this.contextArgs)) {
    const contextKey = snakeToCamel(configKey);
    const value = executableContext[contextKey];
    if (value != null) {
      args.push(flag, String(value));
    }
  }

  return args;
}
```

### 3. Use resolved model in `runExecutableVoice` (`src/ai/analyzer.js`)

Change line 134 from:
```javascript
model: voiceProvider.model || null,
```
to:
```javascript
model: voiceProvider.resolvedModel || null,
```

This way `cli_model: "anthropic:claude-opus-4-6"` gets passed through, `cli_model: ""` resolves to falsy and becomes `null` (not forwarded), and absent `cli_model` falls back to the model ID.

### 4. Update tests

- `tests/unit/executable-provider.test.js`: Add tests for `resolvedModel`, `modelExtraArgs`, `providerExtraArgs` resolution, and `_buildArgs` merging.

## Files to Modify

| File | Change |
|------|--------|
| `src/ai/executable-provider.js` | Steps 1-2: resolve model config, merge extra_args |
| `src/ai/analyzer.js` | Step 3: use `resolvedModel` in `runExecutableVoice` |
| `tests/unit/executable-provider.test.js` | Step 4: test model resolution and extra_args merging |

## Verification

1. `npm test -- --run tests/unit/executable-provider` — unit tests pass
2. `npm test -- --run tests/unit/analyzer` — analyzer tests pass (if any reference runExecutableVoice)
3. Manual: configure Binks with `opus-4-6` model variant, verify the resolved `cli_model` and `extra_args` appear in spawn logs
