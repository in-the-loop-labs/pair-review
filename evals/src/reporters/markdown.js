// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Markdown reporter — generates a human-readable markdown report from
 * eval results for quick review in terminals, PRs, or documentation.
 */

const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low'];

/**
 * Format a decimal score as an integer percentage string (e.g. 0.72 → "72%").
 *
 * @param {number|undefined|null} value
 * @returns {string}
 */
function pct(value) {
  if (value == null || typeof value !== 'number') return '0%';
  return `${Math.round(value * 100)}%`;
}

/**
 * Generate a full markdown report from eval results.
 *
 * @param {object} evalResults - The complete eval results object
 * @returns {string} Markdown-formatted report
 */
export function generateMarkdownReport(evalResults) {
  const meta = evalResults?.meta || {};
  // Support both runner output shape (evalResults.overall) and flat shape (evalResults.scores)
  const scores = evalResults?.overall || evalResults?.scores || {};
  const overall = scores.overall || {};
  const byType = scores.byType || {};
  const bySeverity = scores.bySeverity || {};
  const notableMisses = scores.notableMisses || [];
  const bonusFinds = scores.bonusFinds || [];

  const lines = [];

  // -- Header --
  // Support both meta.config.provider and meta.provider
  const metaConfig = meta.config || {};
  const provider = metaConfig.provider || meta.provider || 'unknown';
  const model = metaConfig.model || meta.model || 'unknown';
  const tier = metaConfig.tier || meta.tier || 'unknown';
  const date = meta.date || meta.completedAt || 'unknown';
  lines.push(`# Eval Run: ${provider}/${model}/${tier} — ${date}`);
  lines.push('');

  // -- Overall Scores --
  lines.push('## Overall Scores');
  lines.push('| Metric | Score |');
  lines.push('|--------|-------|');
  lines.push(`| Recall | ${pct(overall.recall)} |`);
  lines.push(`| Precision | ${pct(overall.precision)} |`);
  lines.push(`| F1 | ${pct(overall.f1)} |`);
  lines.push(`| Weighted Recall | ${pct(overall.weightedRecall)} |`);
  lines.push(`| Ground Truth | ${overall.totalGroundTruth ?? 0} |`);
  lines.push(`| Suggestions | ${overall.totalSuggestions ?? 0} |`);
  lines.push(`| Matches | ${overall.totalMatches ?? 0} |`);
  lines.push(`| False Positives | ${overall.totalFalsePositives ?? 0} |`);
  lines.push('');

  // -- By Type --
  lines.push('## By Type');
  lines.push('| Type | Recall | Precision | F1 | GT Count | Matches |');
  lines.push('|------|--------|-----------|----|----------|---------|');

  const sortedTypes = Object.keys(byType).sort();
  for (const type of sortedTypes) {
    const t = byType[type];
    lines.push(
      `| ${type} | ${pct(t.recall)} | ${pct(t.precision)} | ${pct(t.f1)} | ${t.groundTruthCount ?? 0} | ${t.matchCount ?? 0} |`,
    );
  }
  lines.push('');

  // -- By Severity --
  lines.push('## By Severity');
  lines.push('| Severity | Recall | Count | Matches |');
  lines.push('|----------|--------|-------|---------|');

  // Sort by canonical order; any unknown severities go at the end alphabetically
  const knownSeveritySet = new Set(SEVERITY_ORDER);
  const presentSeverities = Object.keys(bySeverity);
  const sortedSeverities = [
    ...SEVERITY_ORDER.filter((s) => presentSeverities.includes(s)),
    ...presentSeverities.filter((s) => !knownSeveritySet.has(s)).sort(),
  ];

  for (const severity of sortedSeverities) {
    const s = bySeverity[severity];
    lines.push(
      `| ${severity} | ${pct(s.recall)} | ${s.count ?? 0} | ${s.matchCount ?? 0} |`,
    );
  }
  lines.push('');

  // -- Notable Misses --
  lines.push('## Notable Misses');
  if (notableMisses.length === 0) {
    lines.push('(none)');
  } else {
    for (const miss of notableMisses) {
      const severity = miss.severity || 'unknown';
      const prLabel = miss.id != null ? `PR ${miss.id}` : 'unknown PR';
      const title = miss.title || 'untitled';
      const type = miss.type || 'unknown';
      const file = miss.file || 'unknown file';
      lines.push(`- **[${severity}]** ${prLabel}: ${title} (${type}) — \`${file}\``);
    }
  }
  lines.push('');

  // -- Bonus Finds --
  lines.push('## Bonus Finds');
  if (bonusFinds.length === 0) {
    lines.push('(none)');
  } else {
    for (const bonus of bonusFinds) {
      const type = bonus.type || 'unknown';
      const title = bonus.title || 'untitled';
      const file = bonus.file || 'unknown file';
      lines.push(`- ${title} (${type}) — \`${file}\``);
    }
  }
  lines.push('');

  // -- Footer --
  lines.push('---');
  const runId = meta.runId || 'unknown';
  const completedAt = meta.completedAt || 'unknown';
  lines.push(`*Run ID: ${runId} | Completed: ${completedAt}*`);
  lines.push('');

  return lines.join('\n');
}

/**
 * Print the markdown report to stdout.
 *
 * Uses process.stdout.write (not console.log) to avoid an extra trailing newline.
 *
 * @param {object} evalResults - The complete eval results object
 */
export function printMarkdownReport(evalResults) {
  const report = generateMarkdownReport(evalResults);
  process.stdout.write(report);
}
