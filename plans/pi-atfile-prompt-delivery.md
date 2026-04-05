# Pi 0.65.0 Compatibility: @file Prompt Delivery (#445)

## Context

When pair-review sends the analysis prompt to Pi via stdin (`pi.stdin.write(prompt); pi.stdin.end()`), Pi falls back to plain text output instead of JSONL. This breaks streaming progress updates and response parsing.

Pi's `@file` syntax reads the prompt from a file, bypassing stdin entirely. Verified that `@file` works for the positional prompt argument but NOT for `--append-system-prompt`.

## Changes

### 1. `src/ai/pi-provider.js` — `execute()` method

Add `os` and `fs` to imports (line 19-20 area).

Replace stdin-based prompt delivery with `@file`:
- Before spawning: write prompt to a temp file under `os.tmpdir()`, add `@tempPath` to args (both shell and non-shell paths)
- Remove stdin write/error handling (lines 449-462)
- Add temp file cleanup in `close` and `error` handlers

### 2. `src/ai/pi-provider.js` — `getExtractionConfig()`

Change return value from `promptViaStdin: true` to `promptViaFile: true`. Both the shell and non-shell code paths (lines 746-761).

### 3. `src/ai/provider.js` — `extractJSONWithLLM()`

Add `promptViaFile` support alongside existing `promptViaStdin`:
- Destructure `promptViaFile` from config (line 216)
- When `promptViaFile` is true: write prompt to temp file, use `@tempFile` as positional arg, clean up after
- Existing `promptViaStdin` and plain-positional-arg paths unchanged

### 4. `tests/unit/pi-provider.test.js`

- Line 771: Change `promptViaStdin: true` assertion to `promptViaFile: true`
- Any other `promptViaStdin` assertions in the getExtractionConfig describe block

## Hazards

- `getExtractionConfig` is called by the base class `extractJSONWithLLM` in `src/ai/provider.js`. Only PiProvider currently returns `promptViaStdin: true` — other providers return `promptViaStdin: false` or omit it. Adding `promptViaFile` won't affect them.
- `this.baseArgs` is used in both `execute()` and the constructor. The `@file` arg must be appended per-call, not stored in `baseArgs`.
- PiBridge (`src/chat/pi-bridge.js`) uses `--mode rpc` with JSON RPC protocol — NOT affected by the stdin issue. No changes needed there.
- `@file` does NOT work for `--append-system-prompt` — verified by test. Chat system prompt stays as CLI arg.

## Verification

1. `npm test` — unit/integration tests pass
2. `npm run test:e2e` — E2E tests pass
3. Changeset for the version bump
