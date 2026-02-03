#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Generate static markdown reference files for the analyze skill.
 *
 * Renders all 12 prompt combinations (4 types × 3 tiers) from the
 * authoritative JavaScript templates in src/ai/prompts/baseline/ and
 * writes them as standalone markdown files to
 * plugin-code-critic/skills/analyze/references/.
 *
 * Usage:
 *   node scripts/generate-skill-prompts.js
 *   npm run generate:skill-prompts
 */

const fs = require('fs');
const path = require('path');
const { renderPromptForSkill } = require('../src/ai/prompts/render-for-skill');

const PROMPT_TYPES = ['level1', 'level2', 'level3', 'orchestration'];
const TIERS = ['fast', 'balanced', 'thorough'];

const OUTPUT_DIR = path.join(__dirname, '..', 'plugin-code-critic', 'skills', 'analyze', 'references');

// Ensure the output directory exists
fs.mkdirSync(OUTPUT_DIR, { recursive: true });

let generated = 0;

for (const type of PROMPT_TYPES) {
  for (const tier of TIERS) {
    const rendered = renderPromptForSkill(type, tier);

    const header =
      `<!-- AUTO-GENERATED from src/ai/prompts/baseline/${type}/${tier}.js -->\n` +
      `<!-- Regenerate with: npm run generate:skill-prompts -->\n\n`;

    const filename = `${type}-${tier}.md`;
    const filepath = path.join(OUTPUT_DIR, filename);

    fs.writeFileSync(filepath, header + rendered + '\n', 'utf8');
    generated++;
    console.log(`  ✓ ${filename}`);
  }
}

console.log(`\nGenerated ${generated} reference files in ${path.relative(process.cwd(), OUTPUT_DIR)}/`);
