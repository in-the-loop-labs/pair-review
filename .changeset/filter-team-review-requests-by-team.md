---
"@in-the-loop-labs/pair-review": patch
---

Add a team filter to the "Team Review Requests" tab. Enter a team in `org/team` form to narrow the tab to just that team's open review requests (GitHub `team-review-requested:org/team`); leave it blank to keep the default "all my teams" view. The entered team is remembered across sessions, and filtered results are cached separately so they never clobber the all-teams view.
