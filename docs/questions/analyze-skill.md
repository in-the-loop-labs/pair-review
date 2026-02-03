  Tiers: pair-review has three tiers per level — fast, balanced, and thorough — that tune verbosity, model choice, and analysis depth. I used balanced as the basis for the reference files
  and ignored tiers entirely. The skill always runs at one depth. If you wanted tier support, the references could be split (references/level1-fast.md, references/level1-thorough.md, etc.)
   and the SKILL.md could accept a tier argument. But that triples the reference files. Worth considering whether tiers matter in the Claude Code context — the user is already choosing a
  model when they start Claude Code, and the Task subagents inherit it.

  Prompt maintenance: This is the real problem. Right now there are two copies of the analysis logic — the JavaScript prompt templates in src/ai/prompts/baseline/ and the markdown
  reference files in plugin/skills/analyze/references/. They will drift. The JavaScript prompts evolve with pair-review releases; the skill references are static markdown that nobody will
  remember to update.

  Three options:

  1. Accept the drift — the skill references are a simplified distillation, not a copy. They'll diverge naturally as pair-review's prompts get more sophisticated. The skill becomes
  "pair-review-inspired analysis" rather than "pair-review analysis." Honest, but the two will tell different stories over time.
  2. Generate the references from the prompts — a build step that extracts the core instructions from the JavaScript templates and writes the markdown files. Keeps them in sync but adds
  build complexity, and the JavaScript prompts have placeholders and XML section tags that don't map cleanly to what a skill reference should look like.
  3. Expose prompts via MCP — add a get_analysis_prompt tool that returns the rendered prompt for a given level and tier. The skill fetches the prompt at runtime instead of reading static
  reference files. Zero drift, single source of truth, but now the skill depends on the MCP server being connected and adds a round trip per level.

  Option 3 is the cleanest architecturally. The prompts live in one place — pair-review — and the skill just asks for them. It also gets tier support for free.

  What's your preference?
