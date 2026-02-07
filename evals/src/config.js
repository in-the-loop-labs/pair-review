// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));
const EVALS_DIR = resolve(__dirname, '..');
const DEFAULT_CONFIG_PATH = resolve(EVALS_DIR, 'eval-config.yaml');

/**
 * Parse a PR range string into an array of PR numbers.
 *
 * Supported formats:
 *   "3"       → [3]
 *   "1-5"     → [1, 2, 3, 4, 5]
 *   "1,3,5,7" → [1, 3, 5, 7]
 *   "1-3,7,9-10" → [1, 2, 3, 7, 9, 10]
 *
 * @param {string} prString
 * @returns {number[]}
 */
export function parsePrRange(prString) {
  if (typeof prString !== 'string' || prString.trim() === '') {
    throw new Error(`Invalid PR range: expected a non-empty string, got ${JSON.stringify(prString)}`);
  }

  const result = [];
  const segments = prString.split(',');

  for (const segment of segments) {
    const trimmed = segment.trim();
    if (trimmed === '') {
      throw new Error(`Invalid PR range: empty segment in "${prString}"`);
    }

    if (trimmed.includes('-')) {
      const parts = trimmed.split('-');
      if (parts.length !== 2) {
        throw new Error(`Invalid PR range segment: "${trimmed}"`);
      }
      const start = Number(parts[0]);
      const end = Number(parts[1]);
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < 1) {
        throw new Error(`Invalid PR range segment: "${trimmed}" — values must be positive integers`);
      }
      if (start > end) {
        throw new Error(`Invalid PR range segment: "${trimmed}" — start (${start}) must be <= end (${end})`);
      }
      for (let i = start; i <= end; i++) {
        result.push(i);
      }
    } else {
      const num = Number(trimmed);
      if (!Number.isInteger(num) || num < 1) {
        throw new Error(`Invalid PR number: "${trimmed}" — must be a positive integer`);
      }
      result.push(num);
    }
  }

  return result;
}

/**
 * Load the eval configuration from YAML and merge with CLI overrides.
 *
 * @param {object} [options={}]
 * @param {string} [options.configPath] — path to YAML config file
 * @param {string} [options.provider]   — override defaults.provider
 * @param {string} [options.model]      — override defaults.model
 * @param {string} [options.tier]       — override defaults.tier
 * @param {string} [options.repo]       — filter to specific repo name
 * @param {string} [options.prs]        — override PR list ("1-5" or "1,3,5,7")
 * @returns {object} merged configuration
 */
export function loadConfig(options = {}) {
  const configPath = options.configPath || DEFAULT_CONFIG_PATH;

  // Read and parse YAML
  let raw;
  try {
    raw = readFileSync(configPath, 'utf-8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new Error(`Config file not found: ${configPath}`);
    }
    throw new Error(`Failed to read config file ${configPath}: ${err.message}`);
  }

  let config;
  try {
    config = yaml.load(raw);
  } catch (err) {
    throw new Error(`Invalid YAML in ${configPath}: ${err.message}`);
  }

  if (!config || typeof config !== 'object') {
    throw new Error(`Config file ${configPath} did not produce a valid object`);
  }

  // Validate required top-level fields
  if (!Array.isArray(config.repos) || config.repos.length === 0) {
    throw new Error('Config must contain a non-empty "repos" array');
  }
  if (!config.defaults || typeof config.defaults !== 'object') {
    throw new Error('Config must contain a "defaults" object');
  }

  // Validate each repo entry
  for (const repo of config.repos) {
    if (!repo.name) {
      throw new Error('Each repo entry must have a "name" field');
    }
    if (!repo.github) {
      throw new Error(`Repo "${repo.name}" must have a "github" field`);
    }
    if (!Array.isArray(repo.prs)) {
      throw new Error(`Repo "${repo.name}" must have a "prs" array`);
    }
  }

  // Apply CLI overrides to defaults
  if (options.provider !== undefined) {
    config.defaults.provider = options.provider;
  }
  if (options.model !== undefined) {
    config.defaults.model = options.model;
  }
  if (options.tier !== undefined) {
    config.defaults.tier = options.tier;
  }

  // Filter to specific repo if requested
  if (options.repo) {
    const matched = config.repos.filter((r) => r.name === options.repo);
    if (matched.length === 0) {
      const available = config.repos.map((r) => r.name).join(', ');
      throw new Error(`Repo "${options.repo}" not found in config. Available repos: ${available}`);
    }
    config.repos = matched;
  }

  // Override PR list for selected repos
  if (options.prs) {
    const prList = parsePrRange(options.prs);
    for (const repo of config.repos) {
      repo.prs = prList;
    }
  }

  return {
    repos: config.repos,
    defaults: config.defaults,
    matching: config.matching || {},
    scoring: config.scoring || {},
  };
}
