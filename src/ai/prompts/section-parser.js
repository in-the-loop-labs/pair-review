// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Section Parser Utility
 *
 * Parses tagged prompt strings into section objects with metadata.
 * Used by both baseline prompts and the optimization tools.
 *
 * Section tag format:
 *   <section name="section-name" locked="true" required="true" optional="true" tier="fast,balanced">
 *   Content here
 *   </section>
 */

/**
 * Parse a tagged prompt string into section objects
 *
 * @param {string} taggedPrompt - Prompt string with XML-like section tags
 * @returns {Array<Object>} Array of section objects with:
 *   - name: Section identifier
 *   - content: Section content (trimmed)
 *   - locked: Boolean, if true section cannot be modified by variants
 *   - required: Boolean, if true section must be present
 *   - optional: Boolean, if true section can be removed
 *   - tier: Array of tier names this section applies to (optional)
 */
function parseSections(taggedPrompt) {
  const sectionRegex = /<section\s+name="([^"]+)"([^>]*)>([\s\S]*?)<\/section>/g;
  const parsed = [];
  let match;

  while ((match = sectionRegex.exec(taggedPrompt)) !== null) {
    const [, name, attrs, content] = match;
    const section = {
      name,
      content: content.trim(),
      locked: attrs.includes('locked="true"'),
      required: attrs.includes('required="true"'),
      optional: attrs.includes('optional="true"')
    };

    // Extract tier attribute if present
    const tierMatch = attrs.match(/tier="([^"]+)"/);
    if (tierMatch) {
      section.tier = tierMatch[1].split(',').map(t => t.trim());
    }

    parsed.push(section);
  }

  return parsed;
}

/**
 * Get section names in order from a tagged prompt
 *
 * @param {string} taggedPrompt - Prompt string with XML-like section tags
 * @returns {Array<string>} Array of section names in order of appearance
 */
function getSectionOrder(taggedPrompt) {
  const sections = parseSections(taggedPrompt);
  return sections.map(s => s.name);
}

/**
 * Convert parsed sections array to a map keyed by section name
 *
 * @param {Array<Object>} sections - Parsed section objects
 * @returns {Map<string, Object>} Map of section name to section object
 */
function sectionsToMap(sections) {
  const map = new Map();
  for (const section of sections) {
    map.set(section.name, section);
  }
  return map;
}

/**
 * Compute the delta between baseline and optimized prompts
 *
 * @param {string} baselinePrompt - Original baseline tagged prompt
 * @param {string} optimizedPrompt - Optimized tagged prompt
 * @returns {Object} Delta object with:
 *   - sectionOrder: Array of section names in optimized order
 *   - overrides: Map of section name to new content (non-locked only)
 *   - removedSections: Array of section names removed from baseline
 *   - addedSections: Array of {name, content, ...attrs} for new sections
 */
function computeDelta(baselinePrompt, optimizedPrompt) {
  const baselineSections = parseSections(baselinePrompt);
  const optimizedSections = parseSections(optimizedPrompt);

  const baselineMap = sectionsToMap(baselineSections);
  const optimizedMap = sectionsToMap(optimizedSections);

  const baselineNames = new Set(baselineSections.map(s => s.name));
  const optimizedNames = new Set(optimizedSections.map(s => s.name));

  // Section order from optimized prompt
  const sectionOrder = optimizedSections.map(s => s.name);

  // Find overrides (non-locked sections with different content)
  const overrides = {};
  for (const section of optimizedSections) {
    const baselineSection = baselineMap.get(section.name);
    if (baselineSection) {
      // Section exists in both - check if content differs
      // Only store override if section is NOT locked in baseline
      if (!baselineSection.locked && section.content !== baselineSection.content) {
        overrides[section.name] = section.content;
      }
    }
  }

  // Find removed sections (in baseline but not in optimized)
  const removedSections = [];
  for (const name of baselineNames) {
    if (!optimizedNames.has(name)) {
      removedSections.push(name);
    }
  }

  // Find added sections (in optimized but not in baseline)
  const addedSections = [];
  for (const section of optimizedSections) {
    if (!baselineNames.has(section.name)) {
      // Include full section info for new sections
      addedSections.push({
        name: section.name,
        content: section.content,
        locked: section.locked,
        required: section.required,
        optional: section.optional,
        ...(section.tier && { tier: section.tier })
      });
    }
  }

  return {
    sectionOrder,
    overrides,
    removedSections,
    addedSections
  };
}

/**
 * Apply a delta to a baseline prompt to produce an optimized prompt
 *
 * @param {string} baselinePrompt - Original baseline tagged prompt
 * @param {Object} delta - Delta object from computeDelta()
 * @returns {string} Assembled prompt (plain text without section tags)
 */
function applyDelta(baselinePrompt, delta) {
  const baselineSections = parseSections(baselinePrompt);
  const baselineMap = sectionsToMap(baselineSections);

  const { sectionOrder, overrides = {}, removedSections = [], addedSections = [] } = delta;

  // Build map of added sections
  const addedMap = new Map();
  for (const section of addedSections) {
    addedMap.set(section.name, section);
  }

  // Build set of removed sections for quick lookup
  const removedSet = new Set(removedSections);

  // Assemble sections in the specified order
  const assembledParts = [];

  for (const sectionName of sectionOrder) {
    // Skip removed sections
    if (removedSet.has(sectionName)) {
      continue;
    }

    // Check if it's an added section
    if (addedMap.has(sectionName)) {
      const section = addedMap.get(sectionName);
      assembledParts.push(section.content);
      continue;
    }

    // Otherwise use baseline with potential override
    const baselineSection = baselineMap.get(sectionName);
    if (!baselineSection) {
      // Section not found in baseline and not in added - skip
      continue;
    }

    // Use override content if available and section is not locked
    if (overrides[sectionName] && !baselineSection.locked) {
      assembledParts.push(overrides[sectionName]);
    } else {
      assembledParts.push(baselineSection.content);
    }
  }

  // Join with double newlines and clean up extra whitespace
  return assembledParts
    .join('\n\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Rebuild a tagged prompt string from sections
 * Used for debugging and verification
 *
 * @param {Array<Object>} sections - Parsed section objects
 * @returns {string} Tagged prompt string
 */
function rebuildTaggedPrompt(sections) {
  return sections.map(section => {
    const attrs = [];
    attrs.push(`name="${section.name}"`);
    if (section.locked) attrs.push('locked="true"');
    if (section.required) attrs.push('required="true"');
    if (section.optional) attrs.push('optional="true"');
    if (section.tier && section.tier.length > 0) {
      attrs.push(`tier="${section.tier.join(',')}"`);
    }
    return `<section ${attrs.join(' ')}>\n${section.content}\n</section>`;
  }).join('\n\n');
}

module.exports = {
  parseSections,
  getSectionOrder,
  sectionsToMap,
  computeDelta,
  applyDelta,
  rebuildTaggedPrompt
};
