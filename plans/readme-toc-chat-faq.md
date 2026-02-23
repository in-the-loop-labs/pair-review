# README Update: Table of Contents, Chat Section, FAQ Expansion

## Context

The chat feature has been the primary focus of development since v1.6.2 (22 of 68 commits). It's ready to release as part of v2.0.0 but has zero README coverage. The README is ~660 lines and has no table of contents, making navigation harder as it grows.

## Changes

All edits are to `/Users/tim/src/pair_review/README.md`.

### 1. Add Table of Contents

**Where**: After the screenshot (line 11), before `## What is pair-review?` (line 13).

Includes all top-level sections and select second-level sections (Workflows, Configuration subsections, Features subsections). Keeps it compact — no third-level headings.

### 2. Add Chat Subsection Under Features

**Where**: Between `### Three-Level AI Analysis` and `### Customization` (after line 382). Puts the two AI-powered features back-to-back.

Content covers:
- One-line description: talk to an AI agent about the code you're reviewing, powered by Pi
- What you can do (bullet list): ask questions, discuss suggestions, take actions from chat, multiple entry points
- How it works (bullet list): RPC mode, persistent sessions, multiple conversations, custom instructions
- Setup: one-liner with install command (`npm install -g @mariozechner/pi-coding-agent`) + link to AI Provider Configuration. Notes that everything else works without Pi.
- Keyboard shortcut: `p` then `c`

Tone matches existing Features subsections — user benefit first, concise, practical.

### 3. Expand FAQ Section

**Where**: After the existing Pi provider FAQ entry (line 639), before `## Contributing`.

Three new entries:

1. **Why does chat use Pi instead of Claude/other providers?** — Pi provides persistent interactive sessions via RPC with tool access. Analysis providers are one-shot. Pi is model-agnostic.
2. **Do I need Pi installed to use pair-review?** — No. Only chat requires Pi. Without it, the toggle appears grayed out.
3. **How do I set up chat?** — Install Pi, configure models in `providers.pi.models`, chat becomes available automatically.

## Implementation Order

Work bottom-to-top to keep line numbers stable:
1. FAQ entries (near line 639)
2. Chat subsection (near line 382)
3. Table of Contents (near line 11)

## Verification

- Render README on GitHub (or `grip`) and confirm all TOC anchor links work
- Confirm no duplicate information between Chat section and FAQ
- Run existing tests (no code changes, but sanity check)
