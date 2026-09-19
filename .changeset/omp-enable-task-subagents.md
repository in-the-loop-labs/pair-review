---
"@in-the-loop-labs/pair-review": patch
---

Enable OMP's built-in `task` subagent tool for both AI review analysis and chat. OMP only loads tools listed in `--tools`, so omitting `task` silently prevented OMP from delegating exploration to subagents. Also fixes chat task badges whose spinner kept running until turn end when the provider reports the tool as lowercase `task`, and shows a summary of OMP's `tasks[]` input in the tool progress line instead of a bare tool name.
