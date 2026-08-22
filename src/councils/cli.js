// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * `pair-review council <verb>` — manage councils from the command line.
 *
 * The subcommand is dispatched from `main()` BEFORE `parseArgs`, so it parses
 * its own argv and none of the global flag validation applies (`council --help`
 * prints council usage, not the global help).
 *
 * Councils live in two places and the verbs treat them differently:
 *   - DB councils (`CouncilRepository`) are writable: rename, delete, edit.
 *   - File councils (`file:<stem>`, see ./file-councils.js) are a read-only
 *     overlay owned by their file. Every write verb refuses them by name and
 *     points at the file; `edit` writes the FILE rather than the database —
 *     including a file the loader REFUSED, which is unresolvable as a council
 *     but is exactly the file worth editing (see `_findCouncilFile`).
 *
 * No verb ever hands a real path to the editor. Every editing path stages a
 * copy and commits only what validates, so an abort leaves the original — row
 * or file — exactly as it was, and a commit that fails anyway KEEPS the staged
 * copy and prints its path rather than taking the user's work down with it
 * (see `_editTempFile`).
 *
 * Reads go through `CouncilStore` (./council-store.js) so file councils are
 * visible everywhere, and every council serializes through the council document
 * format (public/js/utils/council-document.js) — the same document the UI's
 * Export button produces and the councils directory consumes.
 *
 * Output goes straight to `process.stdout` / `process.stderr` — not through
 * `console` — because `show` and `export`-to-stdout silence console narration
 * to keep their document alone on stdout, and the command's own output has to
 * survive that. The writers, the editor spawn, the confirmation prompt, the
 * temp-dir root, the councils directory, and the database open are all
 * injectable via `_deps` (the `src/protocol-handler.js` pattern) so tests never
 * spawn an editor, read the developer's real config dir, or reassign the test
 * worker's console.
 */

const os = require('os');
const path = require('path');
const crypto = require('crypto');
const fsPromises = require('fs').promises;
const readline = require('readline');
const { spawnSync } = require('child_process');

const { loadConfig, resolveDbName } = require('../config');
const { redirectConsoleToStderr } = require('../mcp-stdio');
const { initializeDatabase, CouncilRepository } = require('../database');
const { applyConfigOverrides, getAllProvidersInfo } = require('../ai');
const { quoteShellArgs } = require('../ai/provider');
const { GlobalSettingsService } = require('../settings/global-settings-service');
const { resolveSingleProviderModel } = require('../review-config');
const logger = require('../utils/logger');
const { createCouncilStore, isFileCouncilId, FILE_ID_PREFIX } = require('./council-store');
const { defaultCouncilsDir } = require('./file-councils');
const {
  resolveCouncilHandle,
  findCouncilNameCollision,
  shortId,
  COUNCIL_NOT_FOUND
} = require('./resolve-council');
const { normalizeAndValidateCouncilConfig } = require('./council-validation');
const { printCouncilList } = require('./print-list');
const {
  buildCouncilDocument,
  parseCouncilDocument,
  councilFilenameStem
} = require('../../public/js/utils/council-document');
const { resolveDefaultOrchestration } = require('../../public/js/utils/provider-map');

/**
 * Ask a question on stdin and resolve with the answer, or `null` at EOF.
 *
 * Resolves on `close` as well as on an answer: with stdin closed or piped from
 * an empty source (`pair-review council delete X < /dev/null`), readline emits
 * `close` and NEVER calls the question callback. A promise that only settles
 * from that callback hangs there forever — with `delete` it would hang before
 * deleting anything, and inside the editor retry loop it would hang holding a
 * temp directory whose cleanup never runs.
 *
 * EOF is `null`, NOT `''`, because the two mean opposite things at the retry
 * prompt: a bare Enter from a real user means "let me edit again", while EOF
 * means there is no user to edit again. Collapsing them made a non-interactive
 * `council edit` on a broken file loop, then die silently with EXIT CODE 0.
 * Callers MUST branch on `null` explicitly.
 *
 * The SPENT-stream check is the other half of that fix, and it is not the same
 * case: an already-ended stream never emits `close` again and never delivers a
 * line, so neither settle path below would ever fire. That is reachable with a
 * single line of piped input — `printf '\n' | pair-review council edit broken`
 * answers prompt #1 with a bare Enter (a retry) and leaves prompt #2 facing a
 * spent stream. better-sqlite3 is synchronous and holds no libuv handle, so the
 * hung promise does not even keep the process alive: the loop drains and the
 * command EXITS 0 having repaired nothing, with its scratch directory leaked
 * (the cleanup sits downstream of an await that never returns). Settle as EOF
 * up front so the caller's existing abort path runs instead.
 *
 * @param {string} question - Prompt text (no trailing newline)
 * @param {Object} [options]
 * @param {stream.Readable} [options.input] - Input stream (default: process.stdin)
 * @param {stream.Writable} [options.output] - Output stream (default: process.stdout)
 * @returns {Promise<string|null>} The user's answer, or null at EOF
 */
function defaultPrompt(question, { input = process.stdin, output = process.stdout } = {}) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input, output });
    let settled = false;
    // `rl.close()` re-emits 'close', so both paths funnel through one guard
    // rather than trying to unsubscribe.
    const settle = answer => {
      if (settled) return;
      settled = true;
      rl.close();
      resolve(answer);
    };

    // Nothing left to read and nothing left to emit — see the note above.
    if (input.readableEnded || input.destroyed) {
      settle(null);
      return;
    }

    rl.on('close', () => settle(null));
    rl.question(question, settle);
  });
}

/**
 * Open the database the same way the rest of the CLI does, and hand back the
 * effective config with it.
 *
 * Order matters and follows the ORDERING CONTRACT in
 * src/settings/global-settings-service.js: config file, database, THEN the
 * in-app /settings overlay, and only then the provider registry
 * (`applyConfigOverrides` latches `config.yolo`, so it must see the overlaid
 * config — and it must still run before any council is read, because
 * file-council validation asks the registry whether a council's voices are
 * executable; without it a user's custom providers' councils are skipped as
 * invalid).
 *
 * `council new` seeds its starter document from `config.default_provider` /
 * `default_model`, which the /settings page stores as DB overrides rather than
 * in the config file — without the overlay the CLI would seed a different
 * provider than the settings page shows. The overlay is guarded the same way
 * src/main.js guards it: a DB read failure leaves the file config intact.
 *
 * @returns {Promise<{db: Object, config: Object, close: Function}>}
 */
async function defaultOpenDatabase() {
  const { config, layers } = await loadConfig();
  const db = await initializeDatabase(resolveDbName(config));
  try {
    Object.assign(config, new GlobalSettingsService({ db, baseConfig: config, layers }).buildEffectiveConfig());
  } catch (error) {
    logger.warn(`Could not apply global-settings overrides: ${error.message}`);
  }
  applyConfigOverrides(config);
  return {
    db,
    config,
    close: () => {
      try { db.close(); } catch { /* ignore */ }
    }
  };
}

/**
 * Injectable dependencies (see `src/protocol-handler.js` for the pattern).
 * `fs` is the promises API.
 */
const defaults = {
  fs: fsPromises,
  spawnSync,
  env: process.env,
  // Written straight to the streams rather than through `console`, because
  // `quietStdout` reassigns console.log — the command's own output must survive
  // that redirect while the narration it silences does not.
  log: (...args) => process.stdout.write(`${args.join(' ')}\n`),
  error: (...args) => process.stderr.write(`${args.join(' ')}\n`),
  prompt: defaultPrompt,
  openDatabase: defaultOpenDatabase,
  // Reserve stdout for the document a verb prints there: opening the database
  // narrates its schema version (and any pending migration) on stdout, which
  // would otherwise land in the middle of `council show > file.json`. Same
  // treatment headless `--json` gives its own stdout document.
  quietStdout: () => redirectConsoleToStderr({ quiet: true }),
  randomUUID: () => crypto.randomUUID(),
  tmpdir: () => os.tmpdir(),
  // Where `edit` looks for a council file the loader refused to load. Shared
  // with the loader rather than re-derived (CLAUDE.md: never re-resolve config
  // values), and injectable so tests never read the developer's config dir.
  councilsDir: defaultCouncilsDir
};

/**
 * Verbs whose stdout carries a council document, and therefore must not share
 * it with progress narration. `export` only qualifies when it is writing to
 * stdout (no file target, or the explicit '-').
 *
 * @param {string} verb - The parsed verb
 * @param {string[]} positionals - Parsed positionals (verb at index 0)
 * @returns {boolean}
 */
function _emitsDocumentOnStdout(verb, positionals) {
  if (verb === 'show') return true;
  return verb === 'export' && (!positionals[2] || positionals[2] === '-');
}

const USAGE = `
pair-review council <command>

Manage saved councils without opening the web UI. Councils defined by files in
~/.pair-review/councils/ are read-only: they can be listed, shown, exported,
duplicated, and validated, but never renamed, deleted, or written in place.

COMMANDS:
    list                          List every council with its handle
    show <handle>                 Print a council document to stdout
    export <handle> [file]        Write a council document to a file ('-' = stdout)
    new <name> [--type <type>]    Create a council in $EDITOR (type: council | advanced)
    edit <handle>                 Edit a council in $EDITOR
    duplicate <handle> <new-name> Copy a council (file councils included) to a new saved council
    rename <handle> <new-name>    Rename a saved council
    delete <handle> [--yes]       Delete a saved council

A <handle> is anything --council accepts: a council name, name-slug, id prefix,
or unique name fragment. Run 'pair-review council list' to see them. Quote a
name that contains spaces.

A council file that fails to load is not listed, but 'edit <filename-stem>'
still opens it so the error can be fixed.

The editor is $VISUAL, then $EDITOR, then vi; a multi-word value such as
'code --wait' works, and quitting the editor with a non-zero status aborts.
`.trimStart();

/**
 * An error whose message is already user-facing: `runCouncilCommand` prints it
 * verbatim and exits 1, with no stack trace.
 */
class CouncilCliError extends Error {}

/**
 * The document-format hook that validates a config exactly the way the runtime
 * will run it: normalize first, then validate the normalized result.
 *
 * @returns {Function} `(config, type) => string|null` for `parseCouncilDocument`
 */
function _validateConfigHook() {
  return (config, type) => normalizeAndValidateCouncilConfig(config, type).error;
}

/**
 * Serialize a council row as a council document.
 *
 * Legacy rows predate the `type` column and are advanced by definition — the
 * same untyped ⇒ advanced rule the UI applies.
 *
 * @param {Object} council - A council row from the store
 * @returns {Object} The council document
 */
function _councilToDocument(council) {
  return buildCouncilDocument({
    name: council.name,
    type: council.type || 'advanced',
    config: council.config,
    description: council.description
  });
}

/**
 * The message for a write whose target row was gone by the time it ran.
 *
 * @param {Object} council - The council that was resolved earlier
 * @returns {string}
 */
function _goneMessage(council) {
  return `Council "${council.name}" (${shortId(council.id)}) no longer exists; nothing was changed.`;
}

/**
 * Refuse a write verb against a file council, mirroring the API's 403.
 *
 * @param {Object} council - The resolved council row
 * @throws {CouncilCliError} When the council is file-owned
 */
function _refuseFileCouncil(council) {
  if (!isFileCouncilId(council.id)) return;
  throw new CouncilCliError(
    `Council "${council.name}" is defined in ${council.filePath}; edit or delete the file instead.`
  );
}

/**
 * Reject a name that another council already answers to.
 *
 * Council names have no database constraint, but they ARE handles: two councils
 * sharing a name turn `--council <name>` into an ambiguity error for both. The
 * comparison lives in `findCouncilNameCollision` next to the resolver whose
 * matching rules it mirrors — name equality alone is too narrow, since the
 * resolver also matches slugified names and file-council filename stems.
 *
 * @param {Object} store - A CouncilStore
 * @param {string} name - The proposed name
 * @param {string} [excludeId] - Council allowed to hold the name (a rename's own row)
 * @throws {CouncilCliError} When the name is taken
 */
async function _assertNameAvailable(store, name, excludeId) {
  const clash = findCouncilNameCollision(await store.list(), name, excludeId);
  if (clash) {
    throw new CouncilCliError(
      `A council named "${clash.name}" (${clash.id}) already answers to "${String(name).trim()}" — ` +
      '`--council` cannot tell them apart. Choose a different name.'
    );
  }
}

/**
 * The orchestration a starter template falls back to when there is no provider
 * metadata to resolve against — an EMPTY provider registry, which means nothing
 * loaded `src/ai` and nothing self-registered. Unreachable through the CLI
 * (this module requires `../ai` at load time) but the resolvers below degrade
 * to the inputs they were given rather than throwing, and the inputs' own last
 * resort is the ALIAS `opus`.
 *
 * The model MUST stay a real canonical id in `src/ai/claude-provider.js` —
 * tests/unit/council-cli.test.js pins it against the live catalog. An
 * unrecognized id falls through `_resolveModelConfig` to `--model <raw string>`
 * and silently loses the catalog entry's `env` (the effort level) and
 * `extra_args`, and the settings UI rewrites it to the canonical id on the next
 * save anyway. `sonnet` in particular is not a Claude alias at all.
 */
const TEMPLATE_ORCHESTRATION_FALLBACK = Object.freeze({
  provider: 'claude',
  model: 'sonnet-5-xhigh',
  timeout: 600000
});

/**
 * The provider/model/timeout a fresh council should be seeded with.
 *
 * Two established resolvers, in the order the rest of the app applies them, and
 * NO new ladder:
 *
 *   1. `resolveSingleProviderModel` (src/review-config.js) — the canonical
 *      single-pick ladder: in-app /settings override › config-file
 *      `default_provider`/`default_model` › the legacy `provider`/`model` keys ›
 *      claude/opus. Repo defaults are deliberately absent, and `null`
 *      repoSettings is how you say so: `council new` names no repository, so
 *      there is no repo tier to consult. A global default COUNCIL is absent for
 *      the same reason — this resolver documents that it never reaches the
 *      council tiers, and a council cannot seed a single voice anyway.
 *   2. `resolveDefaultOrchestration` (public/js/utils/provider-map.js) — the
 *      same coherence pass the two council config tabs run before seeding a new
 *      council: keep the pair only if the provider exists and the model is one
 *      of its ids OR ALIASES, else fall back to that provider's own default
 *      model. `opus` (the ladder's own fallback) and `gpt-5.4` are real aliases
 *      that must land on the canonical id; `sonnet` is not an alias at all and
 *      must land on Claude's default model rather than be written through.
 *
 * Providers with no models are dropped first, for the reason `buildProviderMap`
 * drops them: they cannot supply a model, and `voices[].model is required`.
 * (Filtered here rather than through `buildProviderMap` itself only to keep its
 * per-provider `console.warn` — a browser-console affordance — off the CLI's
 * stderr.)
 *
 * The timeout comes from the resolved provider's own `defaultTimeout`, which is
 * exactly what the config tabs use (`getProviderDefaultTimeout` in
 * public/js/utils/council-crud.js reads the same field off the same payload).
 *
 * @param {Object} [config] - The effective config (may carry `_globalOverrides`)
 * @returns {{provider: string, model: string, timeout: number}}
 */
function resolveTemplateOrchestration(config) {
  const providers = getAllProvidersInfo().filter(p => Array.isArray(p.models) && p.models.length > 0);
  if (providers.length === 0) return { ...TEMPLATE_ORCHESTRATION_FALLBACK };

  const wanted = resolveSingleProviderModel({}, null, config || {});
  const { provider, model } = resolveDefaultOrchestration(providers, wanted.provider, wanted.model);
  const resolved = providers.find(p => p.id === provider);

  return {
    provider: provider || TEMPLATE_ORCHESTRATION_FALLBACK.provider,
    model: model || TEMPLATE_ORCHESTRATION_FALLBACK.model,
    timeout: resolved?.defaultTimeout ?? TEMPLATE_ORCHESTRATION_FALLBACK.timeout
  };
}

/**
 * Starter documents for `council new`.
 *
 * PURE AND SYNCHRONOUS: the orchestration is resolved by the caller
 * (`resolveTemplateOrchestration`, from the config `_new` was handed) and passed
 * in, rather than reached for here.
 *
 * Every voice AND the consolidation get the same pair and the same `tier`, which
 * is what both config tabs' `_defaultConfig()` seeds. `tier` selects the PROMPT
 * set, not a model class — 'balanced' is also what the analyzer falls back to
 * for a voice and for consolidation alike (src/ai/analyzer.js) — so it stays
 * 'balanced' throughout even when the resolved model is a thorough-tier one.
 *
 * NOTE the level shapes: an advanced level that is `enabled` must carry at
 * least one voice or `validateAdvancedFormat` rejects it, so the disabled level
 * is the only one with an empty voices array.
 *
 * @param {string} name - Council name
 * @param {string} type - 'council' or 'advanced'
 * @param {{provider: string, model: string, timeout: number}} [orchestration] -
 *   The resolved pair to seed; defaults to the registry-less fallback
 * @returns {Object} A valid council document
 */
function buildTemplateDocument(name, type, orchestration = TEMPLATE_ORCHESTRATION_FALLBACK) {
  const { provider, model, timeout } = orchestration;
  // A fresh object per voice: a shared reference would alias every level's
  // reviewer onto one object.
  const voice = () => ({ provider, model, tier: 'balanced', timeout });
  const consolidation = voice();

  const config = type === 'advanced'
    ? {
      levels: {
        '1': { enabled: true, voices: [voice()] },
        '2': { enabled: true, voices: [voice()] },
        '3': { enabled: false, voices: [] }
      },
      consolidation
    }
    : {
      voices: [voice()],
      levels: { '1': true, '2': true, '3': true },
      consolidation
    };

  return buildCouncilDocument({ name, type, config });
}

/**
 * Build the shell command line that opens `filePath` in the user's editor.
 *
 * $VISUAL/$EDITOR are COMMAND LINES, not executables: `code --wait`, `subl -w`
 * and `emacsclient -nw` are all ordinary values. Passing one as argv[0] fails
 * with ENOENT, so the value runs through a shell (the same treatment the
 * user-provided checkout script gets in src/git/worktree.js) with the file
 * appended as a quoted argument via `quoteShellArgs` — a council name with a
 * space or a quote in it must reach the editor intact, not word-split.
 *
 * @param {Object} deps - Resolved dependencies
 * @param {string} filePath - The file to edit
 * @returns {{editor: string, command: string}}
 */
function _editorCommand(deps, filePath) {
  const editor = deps.env.VISUAL || deps.env.EDITOR || 'vi';
  return { editor, command: `${editor} ${quoteShellArgs([filePath]).join(' ')}` };
}

/**
 * Open a council document in the user's editor until it parses and validates.
 *
 * Returns the editor's exact bytes ALONGSIDE the parsed document, read once:
 * the two must describe the same save, and a second read to recover the text
 * could pick up whatever an editor daemon wrote after this one returned.
 *
 * `validate` runs INSIDE the loop, on the parsed document, so a rejection the
 * user can fix by editing — a name another council already answers to — is
 * reported and reopened on the same scratch file rather than thrown past the
 * cleanup. Checking it after this function returned deleted the document the
 * user had just authored and left them nothing to recover.
 *
 * @param {Object} deps - Resolved dependencies
 * @param {string} filePath - The scratch file to edit
 * @param {Function} [validate] - `(document) => void|Promise<void>`; throwing
 *   sends the user back to the editor with the error message
 * @returns {Promise<{document: Object, text: string}|null>} The parsed document
 *   and the text it came from, or null when the user aborted
 * @throws {CouncilCliError} When the editor itself cannot be run
 */
async function _editUntilValid(deps, filePath, validate) {
  const { editor, command } = _editorCommand(deps, filePath);

  for (;;) {
    const result = deps.spawnSync(command, [], { stdio: 'inherit', shell: true });
    // A missing editor is not something re-editing can fix — bail out instead
    // of looping the user through a prompt that can only fail again.
    if (result && result.error) {
      throw new CouncilCliError(`Failed to run editor "${editor}": ${result.error.message}`);
    }

    // A failed or killed editor is an ABORT, not a save. The starter template is
    // already valid, so without this `:cq` (or ^C) out of `council new` would
    // "succeed" and create the untouched template, and `edit` would report a
    // successful save of a session the user deliberately threw away.
    if (result && result.signal) {
      deps.error(`Editor "${editor}" was killed by ${result.signal}.`);
      return null;
    }
    if (result && result.status != null && result.status !== 0) {
      deps.error(`Editor "${editor}" exited with status ${result.status}.`);
      return null;
    }

    try {
      const text = await deps.fs.readFile(filePath, 'utf-8');
      const document = parseCouncilDocument(text, { validateConfig: _validateConfigHook() });
      if (validate) await validate(document);
      return { document, text };
    } catch (error) {
      deps.error(error.message);
      const answer = await deps.prompt('Press Enter to edit again, or "q" to abort: ');
      // `null` is EOF — nobody is there to edit again. Retrying would re-open
      // the editor forever against a prompt that can never be answered, and the
      // process would then exit 0 having repaired nothing. A bare Enter ('')
      // IS a retry; only these two cases are the same in `delete`.
      if (answer === null || String(answer).trim().toLowerCase() === 'q') {
        if (answer === null) {
          deps.error('No input available to answer the prompt (stdin is closed).');
        }
        return null;
      }
    }
  }
}

/**
 * Seed a fresh temp file, named `filename`, inside a fresh temp directory.
 *
 * mkdtemp, never a fixed /tmp path: concurrent runs (and concurrent test
 * workers) must not share a scratch file.
 *
 * @param {Object} deps - Resolved dependencies
 * @param {string} filename - Basename for the scratch file (the editor shows it)
 * @param {string|Buffer} contents - What the editor opens on
 * @returns {Promise<{dir: string, filePath: string}>}
 */
async function _writeTempFile(deps, filename, contents) {
  const dir = await deps.fs.mkdtemp(path.join(deps.tmpdir(), 'pair-review-council-'));
  const filePath = path.join(dir, filename);
  await deps.fs.writeFile(filePath, contents, 'utf-8');
  return { dir, filePath };
}

/**
 * Remove a temp directory, best effort.
 * @param {Object} deps - Resolved dependencies
 * @param {string} dir - Directory to remove
 */
async function _cleanupTempDir(deps, dir) {
  try {
    await deps.fs.rm(dir, { recursive: true, force: true });
  } catch { /* a leftover temp dir is not worth failing the command over */ }
}

/**
 * The whole scratch-file edit lifecycle: seed a temp file, edit it until it
 * validates, COMMIT it while that file is still on disk, and remove the temp
 * directory on every exit that can safely take the file with it.
 *
 * All three editing paths (`new`, `edit` on a saved council, `edit` on a
 * council file) go through here, and the cleanup guarantee is the part worth
 * having in exactly one place: copies of a `finally` drift, and the copy that
 * drifts leaks the user's council config into /tmp.
 *
 * The `commit` hook exists because the cleanup used to run FIRST, and every
 * caller then did its real write against a scratch file that no longer existed.
 * A write that failed — the council deleted from the web UI while the editor
 * was open, an unwritable council file — destroyed the document the user had
 * just authored with no recovery path at all. Committing inside the lifecycle
 * makes the rule simple: the scratch file outlives anything that can still fail,
 * and a failed commit KEEPS it and says where it is. Only a clean commit or a
 * deliberate abort throws the file away.
 *
 * NOTHING is edited in place. Whatever the editor is given is a COPY, so an
 * abort — `q`, a non-zero exit, a signal — can always leave the original
 * exactly as it was. The council file path takes raw BYTES rather than a
 * document because the file worth repairing is precisely the one that cannot be
 * parsed into a document.
 *
 * @param {Object} deps - Resolved dependencies
 * @param {string} filename - Basename for the scratch file
 * @param {string|Buffer} contents - What the editor opens on
 * @param {Object} [hooks]
 * @param {Function} [hooks.validate] - Post-parse check run inside the retry
 *   loop; see `_editUntilValid`
 * @param {Function} [hooks.commit] - `({document, text}) => void|Promise<void>`,
 *   the real write; throwing keeps the scratch file and names it in the error
 * @returns {Promise<{document: Object, text: string}|null>} The parsed document
 *   and the exact text the editor saved, or null when the user aborted
 */
async function _editTempFile(deps, filename, contents, { validate, commit } = {}) {
  const { dir, filePath } = await _writeTempFile(deps, filename, contents);
  let keep = false;
  try {
    const edited = await _editUntilValid(deps, filePath, validate);
    if (edited && commit) {
      try {
        await commit(edited);
      } catch (error) {
        keep = true;
        throw new CouncilCliError(`${error.message}\nYour edits were kept at ${filePath}`);
      }
    }
    return edited;
  } finally {
    if (!keep) await _cleanupTempDir(deps, dir);
  }
}

/**
 * `_editTempFile` for a council document that already parses: serialize it,
 * edit the copy, and hand back the parsed result.
 *
 * @param {Object} deps - Resolved dependencies
 * @param {Object} seedDocument - The document the editor opens on
 * @param {Object} [hooks] - `validate` / `commit`, see `_editTempFile`
 * @returns {Promise<Object|null>} The parsed document, or null when the user aborted
 */
async function _editTempDocument(deps, seedDocument, hooks) {
  const edited = await _editTempFile(
    deps,
    `${councilFilenameStem(seedDocument.name)}.council.json`,
    `${JSON.stringify(seedDocument, null, 2)}\n`,
    hooks
  );
  return edited ? edited.document : null;
}

/**
 * Warn when a write to the database would silently drop a description.
 *
 * The `councils` table has no description column — descriptions are a council
 * FILE feature. A document can carry one anyway (the format allows it, and
 * `duplicate` copies file councils that have one), and dropping it without a
 * word is the kind of quiet data loss the user only discovers much later.
 *
 * @param {Object} deps - Resolved dependencies
 * @param {string} [description] - The description on the document being saved
 * @param {string} name - Council name, for the message
 */
function _warnDescriptionDropped(deps, description, name) {
  if (!description || !String(description).trim()) return;
  deps.error(
    `Warning: the description for "${name}" was dropped — saved councils cannot store one. ` +
    'Descriptions are kept only in council files (~/.pair-review/councils/).'
  );
}

/**
 * Parse the subcommand's own argv into positionals and the few flags it takes.
 *
 * @param {string[]} argv - Everything after `council`
 * @returns {{positionals: string[], yes: boolean, type: string|null, help: boolean}}
 * @throws {CouncilCliError} On an unknown flag or a `--type` with no value
 */
function parseCouncilArgs(argv) {
  const positionals = [];
  let yes = false;
  let type = null;
  let help = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') {
      // Everything after `--` is a positional, so a council name that starts
      // with a dash stays reachable.
      positionals.push(...argv.slice(i + 1));
      break;
    } else if (arg === '--yes' || arg === '-y') {
      yes = true;
    } else if (arg === '--help' || arg === '-h') {
      help = true;
    } else if (arg === '--type') {
      const value = argv[i + 1];
      if (!value || value.startsWith('-')) {
        throw new CouncilCliError('--type requires a value: council or advanced');
      }
      type = value;
      i++;
    } else if (arg.startsWith('--type=')) {
      type = arg.slice('--type='.length);
    } else if (arg.startsWith('-') && arg !== '-') {
      // '-' alone is the stdout target for `export`, not a flag.
      throw new CouncilCliError(`Unknown flag: ${arg}`);
    } else {
      positionals.push(arg);
    }
  }

  return { positionals, yes, type, help };
}

/**
 * Require the Nth positional argument.
 *
 * @param {string[]} positionals - Parsed positionals (verb at index 0)
 * @param {number} index - Which one
 * @param {string} label - Name used in the error message
 * @returns {string} The argument
 * @throws {CouncilCliError} When it is missing
 */
function _requireArg(positionals, index, label) {
  const value = positionals[index];
  if (!value || !String(value).trim()) {
    throw new CouncilCliError(`Missing required argument: <${label}>`);
  }
  return value;
}

/**
 * Resolve a handle, restating the resolver's error as a user-facing one.
 *
 * `edit` does NOT use this: it has its own recovery path for a handle that
 * names a council file the loader refused (see `_findCouncilFile`).
 *
 * @param {Object} db - Database instance
 * @param {string} handle - User-supplied handle
 * @returns {Promise<Object>} The resolved council row
 * @throws {CouncilCliError} When resolution fails
 */
async function _resolve(db, handle) {
  try {
    return await resolveCouncilHandle(db, handle);
  } catch (error) {
    throw new CouncilCliError(error.message);
  }
}

/**
 * `council show <handle>` — print the council document.
 */
async function _show(deps, db, positionals) {
  const council = await _resolve(db, _requireArg(positionals, 1, 'handle'));
  deps.log(JSON.stringify(_councilToDocument(council), null, 2));
  return 0;
}

/**
 * `council export <handle> [file]` — write the document to a file or stdout.
 */
async function _export(deps, db, positionals) {
  const council = await _resolve(db, _requireArg(positionals, 1, 'handle'));
  const json = JSON.stringify(_councilToDocument(council), null, 2);
  const target = positionals[2];

  if (!target || target === '-') {
    deps.log(json);
    return 0;
  }

  const filePath = path.resolve(target);
  await deps.fs.writeFile(filePath, `${json}\n`, 'utf-8');
  deps.log(`Exported council "${council.name}" to ${filePath}`);
  return 0;
}

/**
 * `council delete <handle> [--yes]` — delete a saved council after confirming.
 */
async function _delete(deps, db, positionals, { yes }) {
  const council = await _resolve(db, _requireArg(positionals, 1, 'handle'));
  _refuseFileCouncil(council);

  if (!yes) {
    // EOF (`null`) and a bare Enter both mean "not yes", which is the safe
    // default for a destructive verb — unlike the retry prompt, where they
    // differ. Pass --yes to delete without a prompt in a script.
    const answer = await deps.prompt(`Delete council "${council.name}"? [y/N] `);
    if (!/^y(es)?$/i.test(String(answer == null ? '' : answer).trim())) {
      deps.log('Cancelled.');
      return 0;
    }
  }

  // The row can vanish between resolution and the write (the web UI is a live
  // second writer, and the confirmation prompt above blocks for as long as the
  // user takes). Report what actually happened rather than the intent.
  if (!await new CouncilRepository(db).delete(council.id)) {
    throw new CouncilCliError(_goneMessage(council));
  }
  deps.log(`Deleted council "${council.name}" (${shortId(council.id)})`);
  return 0;
}

/**
 * `council rename <handle> <new-name>` — rename a saved council.
 */
async function _rename(deps, db, positionals) {
  const council = await _resolve(db, _requireArg(positionals, 1, 'handle'));
  const newName = _requireArg(positionals, 2, 'new-name').trim();
  _refuseFileCouncil(council);

  const store = await createCouncilStore(db);
  await _assertNameAvailable(store, newName, council.id);

  if (!await new CouncilRepository(db).update(council.id, { name: newName })) {
    throw new CouncilCliError(_goneMessage(council));
  }
  deps.log(`Renamed council "${council.name}" to "${newName}"`);
  return 0;
}

/**
 * `council duplicate <handle> <new-name>` — copy any council into a saved one.
 *
 * File councils are allowed here on purpose: duplicating one is the CLI's
 * counterpart of the UI's Save As, the supported way to get an editable copy.
 */
async function _duplicate(deps, db, positionals) {
  const council = await _resolve(db, _requireArg(positionals, 1, 'handle'));
  const newName = _requireArg(positionals, 2, 'new-name').trim();

  const store = await createCouncilStore(db);
  await _assertNameAvailable(store, newName);

  // A file council carries a description the copy cannot keep.
  _warnDescriptionDropped(deps, council.description, newName);

  const id = deps.randomUUID();
  await new CouncilRepository(db).create({
    id,
    name: newName,
    config: council.config,
    type: council.type || 'advanced'
  });
  deps.log(`Created council "${newName}" (${shortId(id)})`);
  return 0;
}

/**
 * `council new <name> [--type council|advanced]` — author a council in $EDITOR.
 *
 * The starter template is seeded from the user's own global defaults (resolved
 * HERE, at the call site, so `buildTemplateDocument` stays pure), so a user
 * whose default provider is Codex does not get handed a Claude council.
 */
async function _new(deps, db, positionals, { type }, config) {
  const name = _requireArg(positionals, 1, 'name').trim();
  const councilType = type || 'council';
  if (councilType !== 'council' && councilType !== 'advanced') {
    throw new CouncilCliError(`--type must be "council" or "advanced" (got ${JSON.stringify(councilType)})`);
  }

  const store = await createCouncilStore(db);
  await _assertNameAvailable(store, name);

  const template = buildTemplateDocument(name, councilType, resolveTemplateOrchestration(config));
  let id = null;
  const document = await _editTempDocument(deps, template, {
    // The editor may have changed the name, and the web UI may have taken it
    // meanwhile: re-check rather than trusting the pre-edit check. Inside the
    // retry loop, so a collision reopens the document the user just wrote
    // instead of deleting it — `store.list()` re-reads the database each call.
    validate: async document => {
      if (document.name.toLowerCase() !== name.toLowerCase()) {
        await _assertNameAvailable(store, document.name);
      }
    },
    commit: async ({ document }) => {
      _warnDescriptionDropped(deps, document.description, document.name);
      id = deps.randomUUID();
      await new CouncilRepository(db).create({
        id,
        name: document.name,
        config: document.config,
        type: document.type
      });
    }
  });

  if (!document) {
    deps.error('Aborted; no council was created.');
    return 1;
  }

  deps.log(`Created council "${document.name}" (${shortId(id)})`);
  return 0;
}

/**
 * Find the council FILE a handle names, whether or not the loader could load it.
 *
 * Only the stem forms the loader itself recognizes are accepted — `file:<stem>`
 * or a bare `<stem>` — against the same two filename shapes it scans
 * (`<stem>.council.json`, then `<stem>.json`, matching its alphabetical
 * tie-break). Fuzzy handle matching is deliberately NOT reproduced here: a
 * broken file has no name to match on, and guessing at one could open the wrong
 * file for writing.
 *
 * @param {Object} deps - Resolved dependencies
 * @param {string} handle - The unresolvable handle
 * @returns {Promise<string|null>} Path to an existing council file, or null
 */
async function _findCouncilFile(deps, handle) {
  const raw = String(handle || '');
  const stem = raw.toLowerCase().startsWith(FILE_ID_PREFIX)
    ? raw.slice(FILE_ID_PREFIX.length)
    : raw;
  // The loader's own admission rule: the stem is an id that lands in URLs.
  if (!stem || stem !== encodeURIComponent(stem)) return null;

  const dir = deps.councilsDir();
  for (const filename of [`${stem}.council.json`, `${stem}.json`]) {
    const filePath = path.join(dir, filename);
    try {
      if ((await deps.fs.stat(filePath)).isFile()) return filePath;
    } catch { /* not there; try the next shape */ }
  }
  return null;
}

/**
 * Edit a council file through a staged copy, writing back only once the result
 * validates.
 *
 * The file is the council's owner, so there is no database row to write — but
 * there IS something to roll back, which is why the editor never sees the real
 * path. Handing it over directly meant an abort (`q`, a non-zero editor exit, a
 * signal) left behind whatever the editor had already written, and it was worst
 * exactly where it matters most: repairing a file the loader already refused,
 * where "aborted" would have meant "now broken in a new way". Every other verb
 * leaves the original untouched on abort; this one does too.
 *
 * The write-back is the editor's EXACT BYTES, not a re-serialized document.
 * `parseCouncilDocument` answers with a normalized subset — `{name, type,
 * config, description}`, trimmed — so re-serializing would reflow the user's
 * own formatting and silently drop any other key their file carries. This file
 * is the user's artifact; a validation pass should not rewrite it.
 *
 * @param {Object} deps - Resolved dependencies
 * @param {string} filePath - The council file
 * @returns {Promise<number>} Exit code
 * @throws {CouncilCliError} When the file cannot be read, or the result cannot
 *   be written back
 */
async function _editCouncilFile(deps, filePath) {
  let original;
  try {
    // Bytes, not text: the staging copy has to be what the file actually
    // contains, whatever that is.
    original = await deps.fs.readFile(filePath);
  } catch (error) {
    throw new CouncilCliError(`Could not read ${filePath}: ${error.message}`);
  }

  const edited = await _editTempFile(deps, path.basename(filePath), original, {
    // Committed inside the lifecycle so an unwritable council file reports the
    // scratch path instead of deleting the repair the user just made.
    commit: async ({ text }) => {
      try {
        await deps.fs.writeFile(filePath, text, 'utf-8');
      } catch (error) {
        throw new CouncilCliError(`Could not save your edits to ${filePath}: ${error.message}`);
      }
    }
  });
  if (!edited) {
    deps.error(`Aborted; ${filePath} was not changed.`);
    return 1;
  }

  deps.log('Valid. Changes take effect the next time pair-review starts.');
  return 0;
}

/**
 * `council edit <handle>` — edit a saved council, or validate a council file.
 *
 * A file council is written back to its FILE (the file is its owner) and the
 * database is never touched; the command's whole job there is to report whether
 * the result still loads.
 */
async function _edit(deps, db, positionals) {
  const handle = _requireArg(positionals, 1, 'handle');

  let council;
  try {
    council = await resolveCouncilHandle(db, handle);
  } catch (error) {
    // ONLY a no-match failure can mean "a council file the loader refused".
    // Ambiguity means the resolver DID find councils and could not choose
    // between them; falling through to `_findCouncilFile` there would pick the
    // file whose stem matches and write the user's edits into it — the guess
    // every other verb refuses to make, and the one `_findCouncilFile` itself
    // says it will not make. Branch on the code, never on the message text.
    if (error.code !== COUNCIL_NOT_FOUND) {
      throw new CouncilCliError(error.message);
    }
    // A council file that FAILS to parse or validate is skipped by the loader,
    // so it never becomes a resolvable council — precisely the file that most
    // needs a validate-as-you-edit session. Fall back to the file itself before
    // giving up, and do not offer `council new` for a handle that turned out to
    // name a real (broken) file.
    const brokenPath = await _findCouncilFile(deps, handle);
    if (brokenPath) {
      return await _editCouncilFile(deps, brokenPath);
    }
    throw new CouncilCliError(
      `${error.message}\nTo create a new council, run \`pair-review council new <name>\`.`
    );
  }

  if (isFileCouncilId(council.id)) {
    return await _editCouncilFile(deps, council.filePath);
  }

  const store = await createCouncilStore(db);
  const document = await _editTempDocument(deps, _councilToDocument(council), {
    // In the retry loop: a rename onto a taken name is fixable by editing, so
    // the user gets the message and their own document back, not a deleted
    // scratch file. `store.list()` re-reads the database on every call.
    validate: async document => {
      if (document.name.toLowerCase() !== String(council.name).toLowerCase()) {
        await _assertNameAvailable(store, document.name, council.id);
      }
    },
    // The editor blocks for as long as the user is in it — plenty of room for
    // the web UI to delete this council out from under the session. Editing
    // cannot repair that, so the scratch file is kept and named instead.
    commit: async ({ document }) => {
      _warnDescriptionDropped(deps, document.description, document.name);
      if (!await new CouncilRepository(db).update(council.id, {
        name: document.name,
        config: document.config,
        type: document.type
      })) {
        throw new CouncilCliError(_goneMessage(council));
      }
    }
  });

  if (!document) {
    deps.error(`Aborted; council "${council.name}" was not changed.`);
    return 1;
  }

  deps.log(`Updated council "${document.name}" (${shortId(council.id)})`);
  return 0;
}

/**
 * The verb table: handler plus the number of operands the verb reads AFTER the
 * verb itself, so anything beyond that can be rejected instead of dropped.
 *
 * Handlers take `(deps, db, positionals, parsedFlags, config)`; `config` is the
 * effective config the database opener resolved, which only `new` reads.
 *
 * A Map, not an object literal: `council toString` and `council constructor`
 * find `Object.prototype` members on a literal, sail past the unknown-command
 * guard, and then crash or return a non-numeric exit code.
 */
const VERBS = new Map([
  // printCouncilList owns its own console.log output (it is shared with
  // --list-councils), so it takes the db alone.
  ['list', { operands: 0, run: async (_deps, db) => { await printCouncilList(db); return 0; } }],
  ['show', { operands: 1, run: _show }],
  ['export', { operands: 2, run: _export }],
  ['delete', { operands: 1, run: _delete }],
  ['rename', { operands: 2, run: _rename }],
  ['duplicate', { operands: 2, run: _duplicate }],
  ['new', { operands: 1, run: _new }],
  ['edit', { operands: 1, run: _edit }]
]);

/**
 * Run `pair-review council <verb> ...`.
 *
 * @param {string[]} argv - Everything after the `council` word
 * @param {Object} [_deps] - Dependency overrides (see `defaults`)
 * @returns {Promise<number>} Process exit code
 */
async function runCouncilCommand(argv, _deps = {}) {
  const deps = { ...defaults, ..._deps };

  let parsed;
  try {
    parsed = parseCouncilArgs(Array.isArray(argv) ? argv : []);
  } catch (error) {
    deps.error(error.message);
    deps.error('');
    deps.error(USAGE);
    return 1;
  }

  const verb = parsed.positionals[0];

  if (parsed.help || !verb) {
    // `council --help` is usage on stdout (the user asked for it); a missing
    // verb is a usage ERROR on stderr.
    (parsed.help ? deps.log : deps.error)(USAGE);
    return parsed.help ? 0 : 1;
  }

  const spec = VERBS.get(verb);

  if (!spec) {
    deps.error(`Unknown council command: ${verb}`);
    deps.error('');
    deps.error(USAGE);
    return 1;
  }

  // Extra operands are a MISQUOTED NAME, not a nicety to ignore:
  // `council delete My Dream Team --yes` would otherwise be read as the handle
  // `My`, which partial matching happily resolves — to whichever council it
  // finds — and then deletes. Reject before the database is even opened.
  const operands = parsed.positionals.slice(1);
  if (operands.length > spec.operands) {
    deps.error(
      `Too many arguments for \`council ${verb}\`: ${operands.slice(spec.operands).map(a => JSON.stringify(a)).join(', ')}. ` +
      'Quote names that contain spaces, e.g. `pair-review council delete "My Dream Team"`.'
    );
    deps.error('');
    deps.error(USAGE);
    return 1;
  }

  if (_emitsDocumentOnStdout(verb, parsed.positionals)) {
    deps.quietStdout();
  }

  let opened;
  try {
    opened = await deps.openDatabase();
  } catch (error) {
    deps.error(`Failed to open the pair-review database: ${error.message}`);
    return 1;
  }

  // `config` is whatever the opener resolved; an injected opener need not
  // supply one, and every consumer treats a missing config as "no defaults".
  const { db, config, close } = opened;
  try {
    return await spec.run(deps, db, parsed.positionals, parsed, config);
  } catch (error) {
    deps.error(error instanceof CouncilCliError ? error.message : `Error: ${error.message}`);
    return 1;
  } finally {
    close();
  }
}

module.exports = {
  runCouncilCommand,
  parseCouncilArgs,
  _emitsDocumentOnStdout,
  buildTemplateDocument,
  resolveTemplateOrchestration,
  defaultPrompt,
  TEMPLATE_ORCHESTRATION_FALLBACK,
  CouncilCliError,
  COUNCIL_USAGE: USAGE
};
