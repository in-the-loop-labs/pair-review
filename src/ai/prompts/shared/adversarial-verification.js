// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Shared Adversarial Verification section (thorough tier)
 *
 * One fresh-context refutation pass over collected findings, run at the FINAL
 * merge stage of each analysis flow — and only there. Both the orchestration
 * and consolidation thorough templates carry an optional
 * {{adversarialVerification}} placeholder; what varies per flow is the gate
 * that controls the fill:
 *
 * - Single reviewer (analyzeAllLevels) and level-centric council Pass 2
 *   (runCouncilAnalysis): cross-level orchestration fills the placeholder in
 *   orchestration/thorough.js unless options.skipAdversarialVerification is
 *   set (threaded analyzeAllLevels → orchestrateWithAI →
 *   buildOrchestrationPrompt).
 * - Reviewer-centric council (runReviewerCentricCouncil): each voice's
 *   internal cross-level orchestration passes the skip flag — cross-voice
 *   consolidation is this flow's final stage and fills the same placeholder
 *   in consolidation/thorough.js. (The single-voice council shortcut does
 *   not skip: with cross-voice consolidation skipped, that voice's
 *   orchestration IS the final stage.)
 * - Level-centric council Pass 1 (_intraLevelConsolidate) passes ''
 *   deliberately, so findings reach the final pass with cross-voice overlap
 *   and conflict intact as evidence.
 *
 * Why once, at the end: every adversarial pass is an independent chance to
 * wrongly kill a true positive, and the verifier judges best where all
 * sources' agreement and contradiction are visible. Why fresh-context: a
 * reviewer's in-context self-refutation cannot flip a confidently-held
 * misreading; a blank-context reader with the code open can (eval
 * 2026-08-15).
 *
 * Contract (test-pinned): drops require positive refutation evidence;
 * unverifiable findings keep their original confidence; code evidence
 * outranks consensus; verification steps are appended to the reasoning
 * array; repository access is READ-ONLY (the warning is a real mitigation
 * layer under harnesses whose shell tool is not mechanically sandboxed,
 * e.g. Pi).
 *
 * The wording is source-neutral ("sources") so the same text serves both
 * multi-reviewer consolidation and multi-level orchestration inputs.
 */

const ADVERSARIAL_VERIFICATION_SECTION = `## Adversarial Verification
The analyses that produced these findings believed them; you do not have to. You are the first reader with no attachment to any finding — before merging, take a fresh, skeptical pass to weed out false positives. You have READ-ONLY access to the repository: the diff tool shown above, plus \`cat -n\`, \`ls\`, \`grep\`, and \`find\`. Do NOT modify files or run write commands.

You cannot deep-verify everything, so spend verification where it changes the outcome: bug and security findings that are high-severity, corroborated by only a single source (one reviewer or one level), or whose reasoning looks thin or generic.

1. **Check the claim against the code.** Open the cited file at the cited line. Confirm the code actually says what the finding claims — incorrect findings frequently misquote or misread the code. A finding that misdescribes the code is refuted: drop it.
2. **Look for the defense the finding missed.** Read the surrounding code for the guard, validation, type constraint, or caller behavior that would prevent the claimed failure. If it exists, the finding is refuted: drop it, even when multiple sources agree — independent analyses share blind spots, and code evidence outranks consensus.
3. **Dropping requires evidence; doubt does not.** Discard a finding only when you found concrete proof it is wrong. If you could not verify it either way, keep it at its original confidence — inability to verify is not refutation.
4. **Record what you checked.** Append your verification steps to the finding's reasoning array. A finding you verified against the code warrants higher confidence than one you merely passed through.`;

module.exports = { ADVERSARIAL_VERIFICATION_SECTION };
