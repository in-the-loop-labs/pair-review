# Configurable Provider Availability-Check Timeout

## Context

When pair-review starts, it probes each configured AI provider to decide whether
it is available (and the same happens for chat providers, and on the
`/api/providers/refresh-availability` route). Each probe is bounded by a **fixed
10-second timeout**. For providers whose availability check runs a slow command —
e.g. an `executable` provider whose `availability_command` triggers a build/compile
step, or a chat provider with a build-based `availability_command` — 10s is too
short, so the provider is wrongly reported as unavailable.

This change makes the availability-check timeout **configurable per provider**, in
**seconds** (mirroring the existing `checkout_timeout_seconds` convention), for
both AI analysis providers and chat providers. When unset/invalid it stays at the
current 10s default, so existing setups are unaffected.

Decisions (confirmed with user): unit = **seconds**; scope = **analysis + chat
providers**; granularity = **per-provider only** (no global/top-level key).

## Config contract

New optional field, in seconds, positive number:

- AI analysis providers: `providers.<id>.availability_timeout_seconds`
  (applies to built-in, `executable`, and aliased providers)
- Chat providers: `chat_providers.<id>.availability_timeout_seconds`

Absent, non-numeric, or `<= 0` → falls back to the 10s default. Resolution mirrors
`getRepoCheckoutTimeout` in `src/config.js:1266` (`seconds > 0 ? seconds * 1000 : DEFAULT`).

## Where the 10s lives today (all three must be addressed)

1. **Outer race** in `testProviderAvailability(providerId, timeout = 10000)` —
   `src/ai/provider.js:733`. Sole caller of `provider.testAvailability()`
   (`provider.js:743`). This is the *only* timeout for `gemini`, `copilot`,
   `opencode` (their `testAvailability()` has no internal timeout).
2. **Per-provider internal timeouts** (hardcoded `setTimeout(..., 10000)` that also
   `child.kill()`): `claude-provider.js:889`, `codex-provider.js:794`,
   `cursor-agent-provider.js:813`, `pi-provider.js:1135`, `executable-provider.js:471`.
3. **Chat-provider check**: `runCommandAvailabilityCheck` in
   `src/chat/chat-providers.js:307` uses `spawn(..., { timeout: 10000 })`.

## Implementation

### `src/ai/provider.js`
- Add `const DEFAULT_AVAILABILITY_TIMEOUT_MS = 10000;`.
- Add `resolveAvailabilityTimeoutMs(providerId)`: read
  `providerConfigOverrides.get(providerId)?.availability_timeout_seconds`; if a
  positive finite number, return `* 1000`, else `DEFAULT_AVAILABILITY_TIMEOUT_MS`.
  Export it (for unit testing).
- `testProviderAvailability(providerId, timeoutMs)`: when `timeoutMs == null`,
  set `timeoutMs = resolveAvailabilityTimeoutMs(providerId)`. Use `timeoutMs` for
  the outer race **and** pass it through: `provider.testAvailability(timeoutMs)`.
  Include the duration in the timeout error (`Provider test timed out after Ns`).
- In `applyConfigOverrides`, add `availability_timeout_seconds` to the stored
  override object for the **built-in** path (`provider.js:557`) and the **alias**
  path (`provider.js:530`). The **executable** path already spreads the full config
  (`provider.js:516`), so it is covered automatically.
- Update the base `testAvailability()` JSDoc (`provider.js:118`) to document the
  optional `timeoutMs` param.

### Per-provider internal timeouts
For `claude`, `codex`, `cursor-agent`, `pi`, `executable`: change the signature to
`async testAvailability(timeoutMs = 10000)` and use `timeoutMs` in the internal
`setTimeout`; update the "timed out after 10s" log to reflect the actual value
(e.g. `after ${Math.round(timeoutMs / 1000)}s`).

`gemini`, `copilot`, `opencode` have no internal timeout and are left unchanged —
the outer race in `testProviderAvailability` already enforces the resolved value
for them.

### `src/ai/executable-provider.js`
- In the constructor, store `this.availabilityTimeoutMs` from
  `config.availability_timeout_seconds` (positive → `* 1000`, else default) —
  same pattern as the existing `this.timeout = config.timeout || 600000`
  (`executable-provider.js:137`).
- `testAvailability(timeoutMs = this.availabilityTimeoutMs)` uses `timeoutMs`
  for the internal timeout. (Authoritative value still arrives via the param from
  `testProviderAvailability`; the stored field is the default for direct calls.)

### `src/chat/chat-providers.js`
- `getChatProvider`: pass through `availability_timeout_seconds` in **both**
  branches — the dynamic-only branch (~`:123`) and the base+override merge
  (~`:147`), alongside the existing `availability_command` passthrough.
- `checkChatProviderAvailability`: resolve `timeoutMs` from
  `provider.availability_timeout_seconds` (positive → `* 1000`, else 10000) and
  pass it to **both** `runCommandAvailabilityCheck` calls (the
  `availability_command` path and the `<command> --version` fallback).
- `runCommandAvailabilityCheck`: accept a `timeout` (ms) option and use it in
  `spawn(..., { timeout })` instead of the hardcoded `10000`.

### Docs
- `config.example.json`: add `availability_timeout_seconds` to the executable
  provider example, with a short comment noting it also applies to chat providers.
- `README.md`: document the field where executable/provider config and chat
  providers are described.

### Out of scope
- `src/ai/claude-cli.js` `testAvailability` (`:151`): `ClaudeCLI` is **not** a
  registered provider (only `claude-provider.js` registers `'claude'`), so its
  `{ timeout: 10000 }` is unrelated to availability checks — left untouched.
- No config UI control (availability timeout is a startup/infra setting, unlike the
  per-reviewer analysis `timeout` surfaced in `VoiceCentricConfigTab`).

## Hazards

- `testProviderAvailability` is the **sole** caller of `provider.testAvailability()`
  (`provider.js:743`); both external callers (`provider-availability.js:52`,
  `routes/config.js:463`) omit the timeout arg, so resolving when `timeoutMs == null`
  covers them without edits.
- `runCommandAvailabilityCheck` has **two** callers inside
  `checkChatProviderAvailability` — both must receive the resolved timeout.
- `getChatProvider` has **two** return branches; the passthrough must be added to both.
- Provider override storage in `applyConfigOverrides` has **three** shapes
  (executable spreads full config; alias and built-in forward explicit fields only) —
  alias and built-in need the field added explicitly.
- `gemini`/`copilot`/`opencode` rely solely on the outer race — confirm the resolved
  timeout reaches them through `testProviderAvailability` (it does, via the race arg).

## Tests (mandatory)

- `tests/unit/executable-provider.test.js` (existing `testAvailability` block,
  ~`:876`): keep the default-10s timeout test; add a test constructing with
  `availability_timeout_seconds: 30` and asserting the probe is still pending at
  29999ms and resolves `false` + `child.kill()` at 30001ms (fake timers).
- `src/ai/provider.js` (add to the existing provider unit test file, or
  `tests/unit/provider-availability.test.js`): unit-test `resolveAvailabilityTimeoutMs`
  (per-provider override, missing → default, invalid/`<=0` → default) and that
  `testProviderAvailability` passes the resolved ms to `provider.testAvailability`
  and to the race (inject a fake provider via the registry / config overrides).
- One representative built-in provider (e.g. `pi` or `claude`) test: assert the
  internal timeout honors a passed `timeoutMs`.
- `tests/unit/chat/chat-providers.test.js` (existing timeout test ~`:577`): keep the
  default-timeout test; add a test that `availability_timeout_seconds` is passed
  through `getChatProvider` and into the `spawn` `timeout` option.
- Run E2E (`pnpm run test:e2e`) since no frontend changes are made, this is mainly to
  confirm startup availability checks still pass; primary verification is unit tests.

## Verification

1. `pnpm test` — all unit/integration tests pass, including the new ones.
2. Manual: add to `~/.pair-review/config.json` an executable provider with
   `"availability_command": "sleep 20 && true"` and `"availability_timeout_seconds": 30`;
   start pair-review and confirm the provider is reported **available** (with the
   field removed or set low, confirm it reports **unavailable** after ~10s).
3. Repeat for a `chat_providers.<id>` entry with a slow `availability_command` and
   `availability_timeout_seconds`.
4. Add a `patch`/`minor` changeset (`minor` — new feature) for
   `@in-the-loop-labs/pair-review`.
5. Rename this plan file to `plans/configurable-availability-timeout.md`.
