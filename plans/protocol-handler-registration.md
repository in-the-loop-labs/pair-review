# Plan: `pair-review://` Protocol Handler (macOS)

## Context

We want a Chrome extension (future work) to add a "Review in pair-review" button on GitHub/Graphite PR pages. Clicking it should launch pair-review locally and open the PR. This requires registering a custom URL scheme (`pair-review://`) on macOS so the browser can hand off URLs to the local CLI.

This plan covers only the protocol handler registration — not the Chrome extension itself.

## URL Scheme

- `pair-review://pr/owner/repo/123` → Opens PR review

## How It Works

1. `pair-review --register` creates a minimal `.app` bundle at `~/.pair-review/PairReview.app`
2. The `.app` is a compiled AppleScript that receives URLs via macOS `on open location` event
3. The AppleScript invokes `<shell> -l -c '<command> "<url>"'` where:
   - `<shell>` is auto-detected from `$SHELL` (defaults to `zsh`)
   - `<command>` defaults to `npx @in-the-loop-labs/pair-review`, customizable via `--command`
4. Using a login shell (`-l`) sources the user's profile, so `npx`/`node` are findable regardless of how Node was installed (nvm, Homebrew, volta, etc.) — **no literal PATH baking needed**
5. The CLI parses the `pair-review://` URL the same way it handles GitHub/Graphite URLs

### Custom command examples
```bash
pair-review --register                                           # default: npx @in-the-loop-labs/pair-review
pair-review --register --command "npx @in-the-loop-labs/pair-review#main"  # use main branch
pair-review --register --command "node /path/to/dev/bin/pair-review.js"    # local dev build
```

## Changes

### 1. NEW: `src/protocol-handler.js`

Two exported functions: `registerProtocolHandler(options)` and `unregisterProtocolHandler()`.

**`registerProtocolHandler({ command })`:**
1. Guard: warn and exit on non-macOS platforms
2. Detect the user's default shell (`$SHELL` env var, fallback to `zsh`)
3. Resolve the command — default: `npx @in-the-loop-labs/pair-review`, overridable via `--command` flag
4. Generate AppleScript source using `quoted form of theURL` for shell safety:
   ```applescript
   on open location theURL
       do shell script "<shell> -l -c '<command> " & quoted form of theURL & "' &> /dev/null &"
   end open location
   ```
   Where `<shell>` is the detected shell and `<command>` is the resolved command.
5. Compile with `osacompile -o ~/.pair-review/PairReview.app` (pipe source via stdin)
6. Mutate the generated `Info.plist` — insert `CFBundleURLTypes` with scheme `pair-review` and set `CFBundleIdentifier` (raw XML string manipulation, no `plist` npm dep)
7. Register with Launch Services by launching the `.app` once: `open -g -j`
8. Print success message showing the command that will be invoked

**`unregisterProtocolHandler()`:**
1. Guard: warn and exit on non-macOS
2. Deregister via `lsregister -u`
3. Remove `~/.pair-review/PairReview.app`

Import `getConfigDir` from `src/config.js` for the `~/.pair-review` path.

### 2. MODIFY: `src/github/parser.js`

Add `parseProtocolURL(url)` method to `PRArgumentParser`:
- Regex: `/^pair-review:\/\/pr\/([^\/]+)\/([^\/]+)\/(\d+)(?:\/.*)?$/`
- Uses existing `_createPRInfo()` helper

Add protocol URL detection in `parsePRUrl()` — before the GitHub/Graphite checks:
```javascript
if (normalizedUrl.startsWith('pair-review://')) {
    try { return this.parseProtocolURL(normalizedUrl); }
    catch (e) { return null; }
}
```

Update error message in `parsePRArguments()` to mention `pair-review://` format.

### 3. MODIFY: `src/main.js`

- Add `'--register'`, `'--unregister'`, and `'--command'` to `KNOWN_FLAGS` set
- Add early-exit handlers after `--configure` block (before `loadConfig()`):
  ```javascript
  if (args.includes('--register')) {
      const cmdIdx = args.indexOf('--command');
      const command = cmdIdx !== -1 ? args[cmdIdx + 1] : undefined;
      await registerProtocolHandler({ command });
      process.exit(0);
  }
  if (args.includes('--unregister')) { ... process.exit(0); }
  ```
- Add `--register`, `--unregister`, `--command` to skip list in `parseArgs()` (line 246). `--command` consumes the next arg (like `--model` does).
- Update `printHelp()` — add flags to OPTIONS and EXAMPLES sections:
  ```
  --register [--command <cmd>]  Register pair-review:// URL scheme handler (macOS)
                                Default command: npx @in-the-loop-labs/pair-review
  --unregister                  Unregister pair-review:// URL scheme handler (macOS)
  ```

### 4. Tests

**`tests/unit/parser.test.js`** — Add tests for:
- `parseProtocolURL()`: valid PR URL, trailing path, hyphenated names, missing number, non-PR path, non-numeric PR
- `parsePRUrl()`: protocol URL integration, invalid protocol URL returns null
- `parsePRArguments()`: protocol URL as argument

**`tests/unit/protocol-handler.test.js`** (NEW) — Mock `child_process.execSync` and `fs`:
- Warns on non-macOS
- Compiles AppleScript and mutates plist on macOS
- Removes existing .app before creating
- Unregister calls lsregister and removes .app
- Handles "no handler found" gracefully

**`tests/unit/main.test.js`** — `--register` and `--unregister` skipped in parseArgs

### 5. Changeset

Minor bump — new user-facing feature.

## Verification

1. Run unit tests: `npm test`
2. Manual test on macOS:
   - `node bin/pair-review.js --register` → creates `~/.pair-review/PairReview.app`
   - `open "pair-review://pr/facebook/react/12345"` → launches pair-review, opens browser
   - `node bin/pair-review.js --unregister` → removes `.app`
3. Verify non-macOS graceful warning (if available)
