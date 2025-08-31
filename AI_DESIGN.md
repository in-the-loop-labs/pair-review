# AI Integration Design Document

## Overview
This document captures the architectural decisions for Phase 4: AI Integration of the pair-review project.

## Core Design Decisions

### 1. Claude CLI Integration

#### Invocation Method
- Use Node.js `child_process.spawn()` to invoke `claude -p` (print mode)
- Pass high-level review instructions via stdin
- Claude Code autonomously explores the worktree using its tools
- Capture stdout for responses, stderr for diagnostics
- No strict timeout - prioritize thoroughness over speed
- Implement graceful cancellation if user requests

#### Key Advantages of Agentic Approach
- No need to pass file contents in prompts (reduces token usage)
- Claude can explore related files on its own
- Can use grep/find to discover patterns and dependencies
- More thorough analysis as it can follow code paths
- Adaptive exploration based on what it finds

#### Authentication
- No API key required for local Claude CLI
- Fallback to Claude API if CLI not available (future enhancement)

### 2. User Interface Flow

#### Triggering Analysis
- "Run AI Analysis" button in the toolbar (already implemented)
- Opens a modal dialog showing analysis progress
- Modal can be dismissed to run in background
- If dismissed, show a status indicator in the toolbar
- Click status indicator to reopen progress modal

#### Progress Modal Design
```
┌─────────────────────────────────────┐
│ AI Review Analysis                 │
│ ─────────────────────────────────── │
│                                     │
│ ▶ Level 1: Analyzing diff...       │
│   ✓ 3 files analyzed               │
│   ⏳ 2 files remaining             │
│                                     │
│ ⏸ Level 2: File context (pending)  │
│ ⏸ Level 3: Codebase (pending)      │
│                                     │
│ [Run in Background] [Cancel]       │
└─────────────────────────────────────┘
```

#### Background Status Indicator
- Small badge/spinner in toolbar when running in background
- Shows "AI analyzing..." with animated dots
- Click to reopen progress modal
- Changes to checkmark when complete

### 3. Three-Level Analysis Architecture

#### Execution Strategy
- **Sequential execution** (not parallel) to build on previous insights
- Each level receives results from previous level(s)
- Allows for early termination if critical issues found

#### Level 1: Diff Analysis (Isolated Changes)
- **Claude explores**: Uses `git diff` to examine changes
- **Focus**: Issues visible in changed lines alone
- **Categories**: bugs, logic errors, syntax issues
- **Prompt size**: ~500-1000 tokens (just instructions)

#### Level 2: File Context Analysis
- **Claude explores**: Reads full modified files, examines patterns
- **Focus**: Consistency within files, incomplete changes
- **Categories**: missing imports, incomplete refactors, style consistency
- **Prompt size**: ~500-1000 tokens (just instructions + Level 1 summary)

#### Level 3: Codebase Context Analysis
- **Claude explores**: Uses grep/find to discover related files, tests, dependencies
- **Focus**: Architectural impact, breaking changes
- **Categories**: API compatibility, test coverage, performance
- **Prompt size**: ~1000-1500 tokens (just instructions + Level 1&2 summaries)

### 4. Prompt Engineering

#### Output Format
Structured JSON for reliable parsing:

```json
{
  "level": 1,
  "suggestions": [
    {
      "file": "src/server.js",
      "line": 42,
      "lineEnd": 45,
      "type": "bug|improvement|praise|suggestion|design|performance|security",
      "title": "Potential null reference",
      "description": "The variable 'user' may be undefined when accessed",
      "suggestion": "Add null check before accessing user.id",
      "confidence": 0.85
    }
  ],
  "summary": "Found 3 bugs, 2 improvements, and 1 design suggestion"
}
```

#### Comment Types
- **bug**: Actual errors or potential runtime issues
- **improvement**: Better ways to implement existing functionality
- **praise**: Good practices worth highlighting
- **suggestion**: Optional enhancements or alternatives
- **design**: Architecture or pattern concerns
- **performance**: Speed or resource usage issues
- **security**: Security vulnerabilities or concerns

#### Prompt Templates

Since Claude Code is agentic and has direct access to the worktree, we use high-level prompts that let it explore the code autonomously:

**Level 1 - Diff Analysis:**
```
You are reviewing pull request #[PR_NUMBER] in the worktree at [WORKTREE_PATH].

Perform a Level 1 review focusing ONLY on the changes in the diff:
- Review the git diff to understand what changed
- Identify bugs or errors in the modified code
- Find logic issues in the changes
- Highlight security concerns
- Recognize good practices worth praising

Output JSON with this structure:
{
  "level": 1,
  "suggestions": [{
    "file": "path/to/file",
    "line": 42,
    "type": "bug|improvement|praise|suggestion|design|performance|security",
    "title": "Brief title",
    "description": "Detailed explanation",
    "suggestion": "How to fix/improve",
    "confidence": 0.0-1.0
  }],
  "summary": "Brief summary of findings"
}

Focus only on the changed lines. Do not review unchanged code or missing tests (that's for Level 3).
```

**Level 2 - File Context:**
```
You are reviewing pull request #[PR_NUMBER] in the worktree at [WORKTREE_PATH].

Perform a Level 2 review building on these Level 1 findings:
[Level 1 summary]

Now examine the complete files that were changed:
- Use git diff to see what changed
- Read the full content of modified files
- Analyze how changes integrate with existing code
- Find inconsistencies with file patterns
- Identify incomplete refactoring
- Check for local side effects

Output JSON with the same structure as Level 1.
Focus on issues only visible with full file context.
```

**Level 3 - Codebase Context:**
```
You are reviewing pull request #[PR_NUMBER] in the worktree at [WORKTREE_PATH].

Perform a Level 3 review building on previous findings:
Level 1: [summary]
Level 2: [summary]

Now analyze the broader codebase impact:
- Explore related files (imports, tests, dependencies)
- Check for breaking changes to APIs/interfaces
- Verify test coverage for the changes
- Assess architectural consistency
- Evaluate performance implications

Use grep, find, and read tools to explore the codebase as needed.
Output JSON with the same structure.
Focus on system-wide implications.
```

### 5. Response Processing & Storage

#### Parsing Strategy
- Parse JSON response from Claude
- Fallback to structured text parsing if JSON fails
- Validate suggestions have required fields
- Filter out low-confidence suggestions (<0.3)

#### Database Storage
```sql
-- Unified comments table for both AI and user comments
CREATE TABLE comments (
  id INTEGER PRIMARY KEY,
  pr_id INTEGER,
  source TEXT, -- 'ai' or 'user'
  author TEXT, -- Username or 'AI Assistant'
  
  -- AI-specific fields
  ai_run_id TEXT, -- Groups suggestions from same AI analysis run
  ai_level INTEGER, -- 1, 2, or 3
  ai_confidence REAL,
  
  -- Common fields
  file TEXT,
  line_start INTEGER,
  line_end INTEGER,
  type TEXT, -- bug|improvement|praise|suggestion|design|performance|security|comment
  title TEXT, -- Short summary (optional for user comments)
  body TEXT, -- The main comment/suggestion text
  
  -- Status fields
  status TEXT DEFAULT 'active', -- active|adopted|dismissed|resolved
  adopted_as_id INTEGER, -- References the user comment created from this AI suggestion
  parent_id INTEGER, -- For threaded discussions
  
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  
  FOREIGN KEY (adopted_as_id) REFERENCES comments(id),
  FOREIGN KEY (parent_id) REFERENCES comments(id)
);

-- Index for efficient queries
CREATE INDEX idx_comments_pr_file ON comments(pr_id, file, line_start);
CREATE INDEX idx_comments_ai_run ON comments(ai_run_id);
CREATE INDEX idx_comments_status ON comments(status);
```

#### Data Model Considerations
- Unified table allows easy querying of all comments for a line
- AI suggestions can be "adopted" creating a linked user comment
- User can reply to AI suggestions creating threaded discussions
- Status field tracks lifecycle (dismissed AI suggestions hidden by default)
- Type field distinguishes comment purposes while keeping them comparable

#### Caching Strategy
- Cache full analysis run for 24 hours
- Invalidate if PR is updated
- Allow manual re-run to refresh

### 6. UI Integration

#### Display Location
- AI suggestions appear inline with the diff (like local-review comments)
- Visually distinct from user comments (blue gradient background)
- Grouped when multiple suggestions for same line

#### Visual Design (from pair-review-v1)
```css
.ai-suggestion {
  background: linear-gradient(135deg, #f0f8ff 0%, #e6f3ff 100%);
  border-left: 3px solid #0969da;
  position: relative;
}

.user-comment {
  background: white;
  border-left: 3px solid #d1d9e0;
}

.comment-header {
  display: flex;
  align-items: center;
  gap: 8px;
}

.ai-badge {
  background: #0969da;
  color: white;
  padding: 2px 6px;
  border-radius: 12px;
  font-size: 11px;
  font-weight: 600;
}

.type-badge {
  padding: 2px 6px;
  border-radius: 12px;
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
}

/* Type-specific colors */
.type-bug { 
  border-left-color: #cf222e;
  .type-badge { background: #ffebe9; color: #cf222e; }
}
.type-improvement { 
  border-left-color: #0969da;
  .type-badge { background: #ddf4ff; color: #0969da; }
}
.type-praise { 
  border-left-color: #28a745;
  .type-badge { background: #dafbe1; color: #1a7f37; }
}
.type-suggestion { 
  border-left-color: #6f42c1;
  .type-badge { background: #f5f0ff; color: #6f42c1; }
}
.type-design { 
  border-left-color: #f0ad4e;
  .type-badge { background: #fff8dc; color: #9a6700; }
}
.type-performance { 
  border-left-color: #0366d6;
  .type-badge { background: #f0f8ff; color: #0366d6; }
}
.type-security { 
  border-left-color: #d73a49;
  .type-badge { background: #ffeef0; color: #d73a49; }
}
```

#### Interaction Features
- **Adopt**: Converts AI suggestion to user comment
- **Edit**: Modify suggestion before adopting
- **Dismiss**: Hide suggestion (persisted)
- **Expand/Collapse**: For lengthy explanations
- **Reply**: Start a thread discussing the suggestion

### Comment & Suggestion Coexistence

#### Display Hierarchy
For each code line with comments/suggestions:
1. **AI Suggestions** (if not dismissed/adopted)
   - Grouped by type (bugs first, then improvements, etc.)
   - Shows confidence indicator
   - Blue-tinted background
2. **User Comments** (including adopted suggestions)
   - Shows author and timestamp
   - White background
   - Can be marked as resolved
3. **Threaded Replies**
   - Indented under parent comment/suggestion
   - Can mix AI and user responses

#### Interaction Patterns
- User can reply to AI suggestion → Creates thread
- AI suggestion can be adopted → Becomes user comment with "Originally suggested by AI" note
- Multiple users can comment on same line → All shown in chronological order
- Dismissed AI suggestions → Hidden but recoverable via "Show dismissed" toggle

#### Example Combined Display
```
Line 42: user.name.toUpperCase()
├── 🤖 AI Suggestion [BUG] (90% confident)
│   "Potential null reference - add user.name?.toUpperCase()"
│   [Adopt] [Edit] [Dismiss]
│   └── 💬 John: "Good catch, but we validate user earlier"
│       └── 🤖 AI: "The validation is in a different scope..."
├── 💬 Sarah: "We should use a utility function here"
└── 💬 Mike: "Agreed with Sarah" [Resolved]
```

### 7. Server-Side Logging

#### Progress Output to stdout
```
[AI] Starting analysis for PR #123
[AI] Level 1: Analyzing diff (5 files, 234 lines changed)
[AI]   ✓ src/server.js analyzed (2 suggestions)
[AI]   ✓ src/client.js analyzed (1 suggestion)
[AI]   ⏳ src/database.js analyzing...
[AI] Level 1 complete: 5 suggestions found
[AI] Level 2: Analyzing with file context...
[AI] Level 2 complete: 3 additional suggestions
[AI] Level 3: Analyzing codebase impact...
[AI] Level 3 complete: 2 suggestions
[AI] Analysis complete: 10 total suggestions (3 high, 4 medium, 3 low)
```

### 8. Error Handling

#### Failure Modes
- Claude CLI not available → Show clear error with installation instructions
- User cancellation → Save partial results, allow resume
- Parsing error → Log raw response, attempt text extraction fallback
- Token limit exceeded → Split into smaller chunks automatically
- Unexpected termination → Save progress, offer to retry from last checkpoint

#### Graceful Degradation
- If Level 1 fails, disable AI features
- If Level 2/3 fail, show results from successful levels
- Always allow manual review to continue

## Implementation Priority

1. **Phase 4.1 - Basic Integration**
   - Claude CLI wrapper with error handling
   - Level 1 analysis only
   - Simple inline display (no modal yet)
   - Basic adopt/dismiss functionality

2. **Phase 4.2 - Progress UI**
   - Modal dialog for progress
   - Background execution
   - Server stdout logging
   - Improved suggestion styling

3. **Phase 4.3 - Multi-Level Analysis**
   - Implement Level 2 and 3
   - Suggestion grouping
   - Confidence scoring
   - Performance optimization

4. **Phase 4.4 - Polish**
   - Edit suggestions before adopting
   - Batch operations
   - Keyboard shortcuts
   - Analytics/metrics

## Testing Strategy

### Test Scenarios
1. **Small PR**: 1-2 files, <50 lines changed
2. **Medium PR**: 5-10 files, 200-500 lines
3. **Large PR**: 20+ files, 1000+ lines
4. **Edge cases**: Binary files, moved files, merge conflicts

### Mock Mode
- Environment variable `MOCK_AI=true` for development
- Returns predetermined suggestions for test PRs
- Simulates delays and progress updates

## Performance Considerations

### Token Optimization
- With agentic approach, prompts are small (~1K tokens)
- Claude reads only what it needs from files
- Previous level results passed as summaries
- No token limit concerns since Claude manages its own exploration
- Skip binary and generated files automatically

### Response Time Expectations
- Level 1: 10-30 seconds for typical PR (prioritize thoroughness)
- Level 2: 20-60 seconds (depends on file sizes)
- Level 3: 30-90 seconds (depends on codebase complexity)
- Total: 1-3 minutes for complete analysis is acceptable
- Large PRs (1000+ lines): May take 5+ minutes
- User can run in background and continue reviewing manually

### Concurrent Processing
- Process multiple files in Level 2 if under token limit
- Queue system for multiple PR analyses
- Rate limiting to avoid overwhelming Claude CLI

## Security Considerations

- Never send credentials or secrets to Claude
- Sanitize file paths in prompts
- Log prompt sizes but not contents
- Allow users to exclude sensitive files

## Future Enhancements

1. **Chat Interface**: Interactive discussion about specific suggestions
2. **Custom Rules**: User-defined analysis criteria
3. **Learning**: Track adopted vs dismissed to improve suggestions
4. **Metrics**: Dashboard showing AI suggestion effectiveness
5. **Multi-model**: Support for GPT-4, Gemini, etc.
6. **IDE Integration**: VS Code extension for real-time suggestions