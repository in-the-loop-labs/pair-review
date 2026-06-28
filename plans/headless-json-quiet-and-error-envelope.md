# Headless `--json`: quiet-by-default stderr + structured failure envelope

## Context

`--headless --json` is primarily consumed by **coding agents**, not humans. An agent's
shell tool captures *both* stdout and stderr into its context window, so the human
escape hatch (`2>/dev/null`) doesn't apply — every progress line costs the agent
tokens. Two problems follow:

1. **Noise on success.** During a headless JSON run, stdout is already clean (only the
   JSON document), but stderr is flooded with progress narration. `redirectConsoleToStderr()`
   (`src/mcp-stdio.js:27`) routes the ~13 ungated `console.log` narration calls in the
   headless path *and* the analyzer's `logger.section/info/success` chatter to stderr —
   it relocates the noise but doesn't reduce it. The agent eats all of it.

2. **Unstructured failures.** On any error the `main()` catch (`src/main.js:882`) writes a
   prose `❌ Error: …` line to stderr and exits 1, leaving **empty stdout**. An agent that
   parses stdout-as-JSON gets a parse failure and must scrape English from stderr to learn
   what broke. The README "Agent workflow" section (`README.md:327`) even tells agents
   "exit `0` means analysis ran" — there is no machine-readable failure shape.

**Outcome:** make `--headless --json` an agent-native contract — one stream (stdout),
always JSON, success and failure alike; near-silent stderr on success. `--debug`/`-d`
restores verbose stderr for humans diagnosing a run.

## Change 1 — `--json` implies quiet (unless `--debug`)

Suppress progress narration by default in `--headless --json` mode; keep warnings and
errors. `--debug`/`-d` brings the full narration back (on stderr).

**Logger: add a "quiet" concept** — `src/utils/logger.js`
- Add `this.quietEnabled = false;` to the constructor (alongside `debugEnabled`, line 30).
- Add `setQuietEnabled(enabled)` (mirror `setDebugEnabled`, line 49).
- Gate the **chatty** methods only — `info` (107), `success` (120), `log` (169),
  `section` (183): change guard to `if (!this.enabled || this.quietEnabled) return;`.
- Leave `warn` (153) and `error` (135) **ungated by quiet** — they must still emit
  (never swallow warnings/errors). `warn` writes to `this._stdout`, which we redirect to
  stderr below, so it never corrupts the JSON on real stdout.
- Leave `debug`/`streamDebug` as-is (already opt-in via their own flags).

**Centralize the quiet wiring in the existing helper** — `src/mcp-stdio.js`
- Extend `redirectConsoleToStderr(opts)` to accept `{ quiet = false } = {}`:
  - **Default / MCP path (`quiet: false`)** — unchanged: `console.log/info/warn = console.error`,
    `logger.setOutputStream(process.stderr)`, set `PAIR_REVIEW_QUIET_STDOUT`. MCP mode
    (`startMCPStdio`) keeps calling it with no args, so its behavior is untouched.
  - **Quiet path (`quiet: true`)** — drop narration instead of relocating it:
    `console.log = console.info = console.warn = () => {};`, keep `console.error` real
    (→ stderr), `logger.setOutputStream(process.stderr)` (so any `logger.warn` lands on
    stderr, never the JSON stdout), `logger.setQuietEnabled(true)`, set `PAIR_REVIEW_QUIET_STDOUT`.

**Wire at the early lock-down point** — `src/main.js:619-626`
- `parseArgs()` runs *after* this point, so peek raw `args` (same pattern already used for
  `isHeadlessJson`):
  ```js
  const isHeadlessJson = args.includes('--headless') && args.includes('--json');
  if (isHeadlessJson) {
    const wantsDebug = args.includes('-d') || args.includes('--debug');
    redirectConsoleToStderr({ quiet: !wantsDebug });
  }
  ```
- Net effect: success run → stdout = JSON only; stderr = only genuine `logger.warn`/`error`.
  With `--debug`, narration returns on stderr (current behavior).

## Change 2 — failures emit a JSON envelope on stdout

**Symmetry on success** — `src/main.js:2193` (`buildHeadlessJson` return)
- Add `ok: true` to the returned doc: `{ ok: true, mode, run, suggestions, count }`.
  Additive; the human-summary path (`emitHeadlessResult`) ignores it; existing
  `buildHeadlessJson` unit tests still pass.

**Extract a pure error-envelope builder** (testable, mirrors `buildHeadlessJson`) —
`src/main.js`
- Add and export `buildHeadlessErrorJson({ mode, error })` →
  `{ ok: false, mode, error: { message: error.message } }`.

**Emit it from the `main()` catch** — `src/main.js:882-885`
- `flags` is block-scoped to the try and unavailable here; detect mode from `args`:
  ```js
  } catch (error) {
    const jsonMode = args.includes('--headless') && args.includes('--json');
    if (jsonMode) {
      const mode = (args.includes('--local') || args.includes('-l')) ? 'local' : 'pr';
      process.stdout.write(JSON.stringify(buildHeadlessErrorJson({ mode, error }), null, 2) + '\n');
    } else {
      console.error(`\n❌ Error: ${error.message}\n`);
    }
    process.exit(1);
  }
  ```
- Exit stays **non-zero** — exit-code consumers are unaffected; new consumers parse stdout
  and branch on `ok`. Covers all headless failures (flag validation at 644-649, bad
  `--instructions-file`, prep/network/provider errors) since they all propagate here.
- Optional hardening: apply the same JSON-on-stdout treatment to the
  `unhandledRejection` handler (`src/main.js:2421`) using `process.argv`. Low priority;
  the awaited headless path funnels through the `main()` catch.

## Docs

- **Help text** — `src/main.js:166-169` (`--json`): note stderr is quiet by default and
  `--debug` restores verbose logs; mention failures are emitted as JSON (`ok:false`) too.
- **README** — update the `--json` table row (`README.md:197`), the "Headless analysis
  mode" / "Machine-readable output" section (`README.md:267`), and especially the **Agent
  workflow** subsection (`README.md:327-343`): document quiet-by-default stderr, the
  `ok` field, and that failures now produce a JSON envelope on stdout with exit 1 (replace
  the "exit 0 means analysis ran" framing with "parse `ok`; non-zero exit + `ok:false` on
  failure").

## Changeset

- Add `.changeset/*.md`, package `"@in-the-loop-labs/pair-review": minor` (user-facing
  behavior change to the headless JSON contract: quieter stderr + new failure envelope +
  `ok` field). Mirror frontmatter of an existing changeset.

## Hazards

- **`redirectConsoleToStderr` has two callers.** MCP mode (`startMCPStdio` in
  `src/mcp-stdio.js`) and the headless-json lock-down (`src/main.js:625`). The new `quiet`
  param defaults to `false`, so MCP behavior is preserved — verify the MCP call site is
  left arg-less.
- **`logger.warn` must reach stderr, not stdout, in quiet mode.** It writes to
  `this._stdout`; the quiet path must call `setOutputStream(process.stderr)` or a warning
  during a run will corrupt the JSON document. (Quiet keeps warn enabled by design.)
- **Timing: redirect precedes `parseArgs`.** `flags.debug` isn't set at line 625; the
  quiet decision must peek raw `args` for `-d`/`--debug`, consistent with the existing
  `isHeadlessJson` peek.
- **Three council analysis paths** (`src/ai/analyzer.js`: `analyzeAllLevels`,
  `runReviewerCentricCouncil`, `runCouncilAnalysis`) all log via the shared `logger`, so
  the quiet gating covers them automatically — no per-path change needed. No new
  `console.*` calls should be introduced in the headless path; route any through `logger`.
- **Both entry points / both modes.** Headless dispatch (`handleHeadlessAnalysis`,
  `src/main.js:1992`) serves both PR and `--local`; the catch-based envelope is mode-derived
  from `args` and covers both. No web-route parity needed (headless is CLI-only).

## Testing

Per CLAUDE.md, test coverage is mandatory. Reuse existing harnesses.

1. **Logger quiet (unit, new `tests/unit/logger.test.js`).** Inject a fake `_stdout`
   (`logger.setOutputStream(fakeStream)`); with `setQuietEnabled(true)` assert
   `info/success/log/section` produce no output, while `warn` still writes (to the fake
   stream) and `error` still writes to stderr. With quiet off, all emit. Restore logger
   state in `afterEach`.
2. **`redirectConsoleToStderr({ quiet })` (unit, extend `tests/unit/mcp-stdio.test.js`).**
   Save/restore `console.*` in `afterEach`. Assert: `quiet: true` → `console.log` is a
   no-op (does **not** equal `console.error`), `logger.quietEnabled === true`,
   `_stdout === process.stderr`; default → `console.log === console.error` (unchanged).
3. **Success envelope `ok: true` (unit, extend `tests/unit/headless-json.test.js`).**
   Assert `buildHeadlessJson(...)` returns `ok: true` (plus existing assertions unchanged).
4. **Error envelope (unit, extend `tests/unit/headless-json.test.js`).** Assert
   `buildHeadlessErrorJson({ mode: 'local', error: new Error('boom') })` deep-equals
   `{ ok: false, mode: 'local', error: { message: 'boom' } }`.
5. **Failure path end-to-end (integration, `tests/integration/`).** Mirror
   `first-run.test.js`'s `spawnSync` harness (temp `HOME` with a minimal config so it
   passes first-run, `PAIR_REVIEW_NO_OPEN: '1'`). Run
   `--local --headless --json --instructions-file /no/such/file` (resolves first in
   `handleHeadlessAnalysis`, `src/main.js:2001`, so it fails deterministically with no
   network/provider). Assert: exit code `1`, **stdout is the only output and parses as
   JSON** with `ok === false` and a non-empty `error.message`, and stdout contains nothing
   but the JSON document.
6. **Frontend E2E:** none — this is CLI/stderr only, no frontend code touched. Run
   `pnpm test` for the unit/integration suites above.

## Verification

- `pnpm test` (targeted: `logger.test.js`, `mcp-stdio.test.js`, `headless-json.test.js`,
  the new integration test).
- Manual, quiet-by-default (clean success):
  `DEV_NO_AUTO_UPDATE=1 /opt/dev/bin/dev` run of
  `pair-review --local --headless --json 2>/tmp/err.log` → stdout parses as JSON with
  `ok:true`; `/tmp/err.log` is near-empty (no `[AI]` section banners, no `Finding git
  repository…`).
- Manual, debug restores narration:
  `pair-review --local --headless --json --debug 2>/tmp/err.log` → `/tmp/err.log` shows the
  full progress narration again; stdout still clean JSON.
- Manual, failure envelope:
  `pair-review --local --headless --json --instructions-file /no/such/file; echo "exit=$?"`
  → a single JSON object on stdout with `ok:false`, `error.message`, and `exit=1`.
