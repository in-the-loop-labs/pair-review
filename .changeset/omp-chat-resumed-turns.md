---
"@in-the-loop-labs/pair-review": patch
---

Fix OMP chat going silent mid-reply until the page is refreshed

- OMP sends a non-terminal `agent_end` when it pauses for a background job, a queued advisor
  steer, or a compaction/retry continuation, and then picks the turn back up on its own. Chat
  treated that pause as the end of the reply. It saved a partial answer, closed the bubble,
  and dropped the rest of the reply. The input also stopped taking messages. Chat now waits
  for the terminal `agent_end` and saves the whole reply as one message.
- A message sent while OMP is paused (for example from a page reloaded mid-reply) is now
  rejected with an explanation, and its text goes back into the input. Before, it started a
  new turn and the paused reply was lost. The chat then shows the reply in progress with a
  Stop button, and the full reply once it finishes. Clicking Stop during a pause ends the
  reply and saves what OMP wrote so far. That text is also saved if OMP exits, or the chat
  tab or server is closed, during a pause.
- Output from a turn the agent starts on its own, such as an OMP advisor waking it after a
  reply finished, now opens a new chat bubble instead of disappearing. Output still in
  flight after you click Stop is dropped as before. Opening that bubble no longer scrolls
  you to the bottom if you scrolled up.
- A reply that was already under way when the page loaded now shows in full once it
  finishes, below the loaded history, instead of only the part streamed after the load, or
  nothing at all when none of it streamed to the page.
- OMP `notice` events are now logged at their level (warnings and errors show in the server
  log). OMP status-line events such as `advisor_yielded` are no longer logged as
  "Unhandled event type".
