// SPDX-License-Identifier: GPL-3.0-or-later
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { getConfigDir } = require('./config');
const logger = require('./utils/logger');

// Default dependencies (overridable for testing)
const defaults = {
  fs,
  execSync,
  getConfigDir,
  logger,
};

/**
 * Register a macOS custom URL scheme handler for pair-review://
 * Creates an AppleScript .app that forwards URLs to the pair-review CLI.
 *
 * @param {object} [options]
 * @param {string} [options.command] - CLI command to invoke (default: npx @in-the-loop-labs/pair-review)
 * @param {object} [options._deps] - Internal: dependency overrides for testing
 */
function registerProtocolHandler({ command, _deps } = {}) {
  const deps = { ...defaults, ..._deps };

  if (process.platform !== 'darwin') {
    deps.logger.warn('Protocol handler registration is only supported on macOS');
    return;
  }

  const shell = process.env.SHELL || '/bin/zsh';
  const resolvedCommand = command || 'npx @in-the-loop-labs/pair-review';

  const appleScriptSource = [
    'on run',
    '\t-- No-op: launched directly without a URL',
    'end run',
    '',
    'on open location theURL',
    `\tdo shell script "${shell} -l -c \\"${resolvedCommand} " & quoted form of theURL & " > /dev/null 2>&1 &\\""`,
    'end open location',
  ].join('\n');

  const appPath = path.join(deps.getConfigDir(), 'PairReview.app');

  // Remove existing .app if present
  deps.fs.rmSync(appPath, { recursive: true, force: true });

  // Compile the AppleScript into an .app bundle
  deps.execSync(`osacompile -o "${appPath}"`, { input: appleScriptSource });

  // Mutate Info.plist to declare the URL scheme
  const plistPath = path.join(appPath, 'Contents', 'Info.plist');
  let plist = deps.fs.readFileSync(plistPath, 'utf-8');

  const urlSchemeEntries = [
    '\t<key>CFBundleIdentifier</key>',
    '\t<string>com.pair-review.launcher</string>',
    '\t<key>CFBundleURLTypes</key>',
    '\t<array>',
    '\t\t<dict>',
    '\t\t\t<key>CFBundleURLName</key>',
    '\t\t\t<string>pair-review URL</string>',
    '\t\t\t<key>CFBundleURLSchemes</key>',
    '\t\t\t<array>',
    '\t\t\t\t<string>pair-review</string>',
    '\t\t\t</array>',
    '\t\t</dict>',
    '\t</array>',
  ].join('\n');

  // Insert before the closing </dict> that precedes </plist>
  plist = plist.replace('</dict>\n</plist>', `${urlSchemeEntries}\n</dict>\n</plist>`);
  deps.fs.writeFileSync(plistPath, plist);

  const lsregister = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';
  deps.execSync(`"${lsregister}" -R -f "${appPath}"`);

  console.log('Registered pair-review:// URL scheme handler');
  console.log(`Command: ${shell} -l -c '${resolvedCommand} <url>'`);
}

/**
 * Unregister the macOS custom URL scheme handler for pair-review://
 * Removes the .app bundle and deregisters from Launch Services.
 *
 * @param {object} [options]
 * @param {object} [options._deps] - Internal: dependency overrides for testing
 */
function unregisterProtocolHandler({ _deps } = {}) {
  const deps = { ...defaults, ..._deps };

  if (process.platform !== 'darwin') {
    deps.logger.warn('Protocol handler registration is only supported on macOS');
    return;
  }

  const appPath = path.join(deps.getConfigDir(), 'PairReview.app');

  // Attempt to deregister from Launch Services (may fail if not registered)
  try {
    deps.execSync(`/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -u "${appPath}"`);
  } catch {
    // Ignore — handler may not be registered
  }

  // Remove the .app bundle
  deps.fs.rmSync(appPath, { recursive: true, force: true });

  console.log('Unregistered pair-review:// URL scheme handler');
}

module.exports = { registerProtocolHandler, unregisterProtocolHandler };
