#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Synchronizes the version from package.json into the plugin manifest files:
 *   - .claude-plugin/marketplace.json  (metadata.version + plugins[0].version)
 *   - plugin/.claude-plugin/plugin.json (version)
 *
 * Run automatically as part of `npm run version` (after changeset version).
 */

'use strict';

const { readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

const root = join(__dirname, '..');

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const version = pkg.version;

const files = [
  {
    path: join(root, '.claude-plugin', 'marketplace.json'),
    update(obj) {
      obj.metadata.version = version;
      if (obj.plugins && obj.plugins[0]) obj.plugins[0].version = version;
      return obj;
    },
  },
  {
    path: join(root, 'plugin', '.claude-plugin', 'plugin.json'),
    update(obj) {
      obj.version = version;
      return obj;
    },
  },
];

let changed = 0;
for (const { path, update } of files) {
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    console.error('sync-plugin-versions: failed to read ' + path + ': ' + err.message);
    process.exit(1);
  }

  let obj;
  try {
    obj = JSON.parse(raw);
  } catch (err) {
    console.error('sync-plugin-versions: failed to parse ' + path + ': ' + err.message);
    process.exit(1);
  }

  const updated = update(obj);
  const newRaw = JSON.stringify(updated, null, 2) + '\n';
  if (newRaw !== raw) {
    try {
      writeFileSync(path, newRaw);
    } catch (err) {
      console.error('sync-plugin-versions: failed to write ' + path + ': ' + err.message);
      process.exit(1);
    }
    console.log('sync-plugin-versions: updated ' + path + ' to ' + version);
    changed++;
  }
}

if (changed === 0) {
  console.log('sync-plugin-versions: all files already at ' + version);
} else {
  console.log('sync-plugin-versions: ' + changed + ' file(s) updated to ' + version);
}
