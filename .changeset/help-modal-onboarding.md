---
"pair-review": patch
---

Add help modal and improve onboarding experience

- Add help modal with "?" button in header for accessing help anytime
- Fix loading state flash where help content briefly appeared before reviews loaded
- Include local mode instructions (`--local [path]`) in help content
- Dynamically show correct command based on npx vs npm install
- Add ARIA attributes for accessibility (role="dialog", aria-labelledby, aria-modal)
- Add E2E tests for help modal interactions
