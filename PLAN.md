# Pair-Review Implementation Plan

## Purpose
This document tracks the implementation progress, decisions made, and current status of the pair-review project. Updated continuously as work progresses.

## Implementation Phases

### Phase 1: Foundation ✅ COMPLETE
- [x] Project setup (package.json, directory structure)
- [x] Basic Express server
- [x] Configuration management
- [x] SQLite database setup and schema
- [x] Basic HTML page serving

### Phase 2: GitHub Integration
- [ ] GitHub authentication with PAT
- [ ] Fetch PR metadata via API
- [ ] Clone/checkout PR branch locally
- [ ] Fetch and parse PR diff
- [ ] Git worktree management

### Phase 3: Core UI
- [ ] GitHub-like diff viewer
- [ ] File navigator/tree
- [ ] Unified diff display
- [ ] Expandable context lines
- [ ] Dark/light theme support

### Phase 4: AI Integration
- [ ] Claude CLI wrapper
- [ ] Prompt engineering for 3-level review
- [ ] Parse AI responses
- [ ] Categorize suggestions
- [ ] Adapter pattern implementation

### Phase 5: Review Workflow
- [ ] Display AI suggestions inline
- [ ] Adopt/edit/discard controls
- [ ] User comment creation
- [ ] Draft saving
- [ ] Review submission to GitHub

### Phase 6: Polish & Testing
- [ ] Error handling
- [ ] Loading states
- [ ] Performance optimization
- [ ] End-to-end testing
- [ ] Documentation

## Current Sprint
**Sprint**: Phase 2 - GitHub Integration
**Focus**: GitHub API integration and PR checkout
**Blockers**: None

## Implementation Log

### Date: 2025-08-30
**Completed**:
- Phase 1: Foundation Infrastructure (100% QA verified)
- Package setup with npx executable
- Express server with port management
- SQLite database with full schema
- Configuration management system
- Basic HTML page serving

**Decisions Made**:
- Used agent team approach (PM -> Engineer -> QA -> Fix -> Commit)
- Implemented exact error messages and exit codes per requirements
- Added automatic port fallback for better UX
- Used CHECK constraints in database for data integrity

**Issues Encountered**:
- Initial database schema missing CHECK constraints - FIXED
- Error messages not matching exact spec - FIXED
- Index names not matching requirements - FIXED
- All issues resolved after QA cycle

**Next Steps**:
- Phase 2: GitHub Integration
- Implement Octokit for API access
- Add PR fetching and checkout logic

---

## Technical Decisions Record

### Decision: [Title]
**Date**: [Date]
**Context**: Why this decision was needed
**Decision**: What was decided
**Rationale**: Why this approach was chosen
**Alternatives Considered**: Other options evaluated

---

## QA Cycles

### Feature: Phase 1 - Foundation Infrastructure
**Implementation Date**: 2025-08-30
**QA Date**: 2025-08-30
**Status**: Pass (after fixes)
**Issues Found**: 
- Missing database CHECK constraints
- Incorrect error messages and exit codes
- Wrong index names
- Extra HTML elements beyond requirements
**Resolution**: All issues fixed by Engineer
**Retest Date**: 2025-08-30 - PASSED 

---

## Dependencies & Libraries

### Confirmed:
- Express.js - web server
- sqlite3 - Database

### Under Consideration for Phase 2:
- Octokit - GitHub API client (Phase 2)
- simple-git - Git operations (Phase 2)
- diff2html - Diff rendering (Phase 3)

---

## Notes for Team

### For Software Engineer:
- Remember to update MENTAL_MODEL.md after each task
- Focus on MVP features only

### For Product Manager:
- Requirements must be 100% complete and specific

### For QA Engineer:
- Test against exact requirements, report any deviation

### For CTO:
- Coordinate sprints and resolve blockers

---

## Open Questions
- [ ] Question 1
- [ ] Question 2

## Parking Lot (Future Ideas)
- Ideas that come up during implementation but are out of scope for MVP