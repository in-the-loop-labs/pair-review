# Comment Format Hint in Chat

## Context

When the chat agent adopts a comment with edits, it usually does not follow the user's configured comment format (e.g., `{emoji} **{category}**: {description}`). The model needs to be told what format to use. The comment format can also change between server restarts (user edits config), so it must be re-communicated on session resume.

## Approach

Inject the resolved comment format template into the chat at two points:

1. **Session creation** — add a section to the system prompt that explains the comment format and instructs the model to follow it when writing or editing comments.
2. **Session resume** — inject just the current template value as resume context (alongside the existing port correction), so the model picks up any config changes without repeating the full instructions.

## Files to Modify

### 1. `src/chat/prompt-builder.js` — `buildChatPrompt()`

Add a new optional parameter `commentFormat` (the resolved template string). Add a new section to the system prompt after the domain model section:

```
## Comment format

When creating or editing review comments, use this template:
<template>
{emoji} **{category}**: {description}{?suggestion}\n\n**Suggestion:** {suggestion}{/suggestion}
</template>

Template placeholders: {emoji}, {category}, {title}, {severity}, {description}, {suggestion}.
Conditional sections: {?field}...{/field} — include content only when the field has a value.
Always follow this format for consistency with the reviewer's preferences.
```

Only add this section when `commentFormat` is provided (non-null).

### 2. `src/routes/chat.js` — `POST /api/chat/session`

Before calling `buildChatPrompt()`, resolve the comment format template from config:

```js
const { resolveFormat } = require('../utils/comment-formatter');
// ...
const formatConfig = resolveFormat(config.comment_format);
const commentFormatTemplate = formatConfig.template;
```

Pass `commentFormatTemplate` to `buildChatPrompt()`.

### 3. `src/routes/chat.js` — Resume paths (explicit + auto-resume)

In both the `POST /api/chat/session/:id/resume` handler and the auto-resume block in `POST /api/chat/session/:id/message`:

Append the current comment format template to the resume/port-correction context:

```js
const formatConfig = resolveFormat(config.comment_format);
portCorrectionContext += `\n\n[Comment format template: ${formatConfig.template}]`;
```

This is lightweight — no instructions repeated, just the current template value. The model already knows what it means from the original system prompt.

### 4. Tests

- **Unit test** for `buildChatPrompt`: verify the comment format section appears in the system prompt when `commentFormatTemplate` is provided, and does not appear when omitted.
- **Unit/integration test** for chat routes: verify the comment format template is included in resume context.

## Hazards

- `buildChatPrompt()` has a single caller in `src/routes/chat.js` (called from both session create and resume/auto-resume paths for system prompt rebuilding). Adding a parameter is safe.
- The resume context path has two injection points: explicit resume (`POST .../resume`) and auto-resume (in `POST .../message`). Both must include the comment format.
- `resolveFormat()` is already imported in `src/routes/reviews.js` but not in `src/routes/chat.js` — need to add the import.
- Config is accessed via `req.app.get('config')` — already available in all relevant route handlers.

## Verification

1. Run `npm test` — existing tests pass
2. Run new unit tests for prompt builder
3. Manual test: start a chat session, verify system prompt includes comment format section; resume session, verify resume context includes template
