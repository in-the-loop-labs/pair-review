---
"pair-review": minor
---

Add a "system" theme option that follows the OS light/dark setting. The header
theme toggle now cycles light → dark → system, the system choice tracks OS
appearance changes live, and a first-time visitor (no saved choice) follows the
OS by default. Theme logic is consolidated into a shared `public/js/theme.js`
helper plus a single `public/js/theme-bootstrap.js` pre-paint script, replacing
the previously duplicated per-page toggle code and six inline bootstraps.

The now-redundant "Default theme" row is removed from the global settings page —
the header toggle owns theme entirely. The `theme` config field is unchanged and
`/api/config` still returns it.
