// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest';

global.window = global.window || {};

const SuggestionUI = require('../../public/js/utils/suggestion-ui.js');

describe('SuggestionUI.formatSuggestionMarkdown()', () => {
  it('formats a line-level suggestion with metadata, formatted body, and reasoning', () => {
    const markdown = SuggestionUI.formatSuggestionMarkdown({
      title: 'Reject oversized Vault user IDs before querying',
      file: 'app/graphql/resolvers/vault_user_resolver.rb',
      lineStart: 44,
      lineEnd: 48,
      type: 'bug',
      severity: 'critical',
      body: 'Raw body should not be used',
      formattedBody: 'Bug: `parse_vault_user_id` currently accepts any positive integer.',
      reasoning: [
        'Checked the resolver input path.',
        'Confirmed oversized IDs can reach ActiveRecord binding.'
      ]
    });

    expect(markdown).toBe(`## Reject oversized Vault user IDs before querying
- File: \`app/graphql/resolvers/vault_user_resolver.rb\`
- Location: lines 44-48
- Type: Bug
- Severity: Critical

Bug: \`parse_vault_user_id\` currently accepts any positive integer.

### Reasoning
- Checked the resolver input path.
- Confirmed oversized IDs can reach ActiveRecord binding.`);
  });

  it('formats a file-level suggestion without optional severity or reasoning', () => {
    const markdown = SuggestionUI.formatSuggestionMarkdown({
      title: 'Document module ownership',
      file: 'src/ownership.js',
      isFileLevel: true,
      type: 'suggestion',
      body: 'Add ownership details near the top of the file.'
    });

    expect(markdown).toBe(`## Document module ownership
- File: \`src/ownership.js\`
- Location: file-level
- Type: Suggestion

Add ownership details near the top of the file.`);
  });
});
