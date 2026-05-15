# Spec-Driven Ralph: One-Shot Faithful Game Recreation

## Problem

Ralph currently verifies **completion** (build passes, todos done, deployed) but not **fidelity** (does the output match the spec and reference material?). A worker can complete all 7 tasks and produce something that looks nothing like the target.

Example: Super Off Road spec demanded isometric sprite-based rendering, but the worker built a flat top-down game with colored rectangles — and ralph signed off because it "worked."

## Root Cause

1. **No reference images in context**: The worker never saw the original game. It read the spec text but had no visual reference to match against.
2. **Ralph has no acceptance criteria beyond "it builds"**: Ralph's prompt checks task completion, not visual/behavioral fidelity.
3. **Phase gating not enforced**: The spec said "MUST complete research before coding" but nothing prevented the worker from skipping straight to implementation.

## Solution: Three-Layer Spec Enforcement

### Layer 1: Reference-Enriched Initial Prompt

When kicking off a spec-driven build, the supervisor (or user) sends:
1. The spec text (or a pointer to `SPEC.md`)
2. **Reference images** — screenshots of the target, attached as a Telegram media group (now batched into a single CC message thanks to the multi-image fix)
3. An explicit instruction: "Study these reference images carefully. Your output must visually match them."

**Implementation**: `tgcc_send` or `tgcc_session(action="new", prompt="...")` already supports text. The multi-image batching fix means sending 2-5 reference screenshots in a Telegram album will arrive as one CC message with all images visible.

For programmatic use (supervisor MCP), we need a way to attach images to `tgcc_send`. Today this only works via Telegram (user sends photos). A future enhancement could allow file paths in `tgcc_send`.

**Workaround today**: User sends reference images via Telegram to the agent's chat, then sends the text prompt. The batcher combines them.

### Layer 2: Ralph with Visual Acceptance Criteria

Ralph's prompt needs to include:
1. The **spec** (or key sections of it)
2. A **verification checklist** derived from the spec — not just "does it build" but specific visual/behavioral criteria
3. Access to the **deployed URL** so ralph can screenshot and compare
4. The **reference images** (sent to ralph's context at spawn time)

**New `tgcc_ralph` parameter**: `spec` — a string or file path that ralph includes in its verification criteria.

**Ralph prompt enhancement** (in `ralph.ts`):

```
## Verification Criteria

You are not just checking that the worker's tasks are complete. You are verifying that the output FAITHFULLY matches the specification and reference material.

For visual projects (games, UIs), you MUST:
1. Navigate to the deployed URL using the browser
2. Take a screenshot
3. Compare against the reference images and spec requirements
4. If the output doesn't match the spec's visual requirements, send the worker back with specific feedback ("the track should be isometric, not flat top-down", "trucks should be sprites with rotation frames, not colored rectangles")

DO NOT sign off on a project that merely "works" but doesn't match the spec.
```

### Layer 3: Phase Gating via Spec Structure

Specs should define explicit phases with gates:

```markdown
## Phase 0: Research (GATE: must produce RESEARCH.md before Phase 1)
## Phase 1: Core Engine (GATE: must demo sprite rendering before Phase 2)
## Phase 2: Gameplay (GATE: must show playable race before Phase 3)
## Phase 3: Polish & Deploy
```

Ralph enforces gates by:
1. Checking the worker's todo list for phase completion
2. Verifying gate deliverables exist (e.g., RESEARCH.md is non-empty)
3. Refusing to let the worker skip ahead

## Implementation Plan

### Step 1: Ralph Spec Parameter (ralph.ts)

Add `spec?: string` to `tgcc_ralph` MCP tool. When provided:
- Include the spec text in ralph's system prompt
- Add visual verification instructions to the prompt
- Ralph uses browser tools to screenshot the deployed result and compare

### Step 2: Ralph Browser Verification

Ralph already has MCP access. Add instructions to ralph's prompt:
- "If the spec includes a deployment URL, navigate to it and take a screenshot after the worker claims completion"
- "Compare the screenshot against the spec's visual requirements"
- "If it doesn't match, send the worker specific feedback and DO NOT call ralph_done"

### Step 3: Reference Image Flow

For Telegram-initiated builds:
1. User sends reference images as an album → batched into one CC message (DONE with multi-image fix)
2. User sends `/new <prompt>` or just types the task description
3. Worker sees images + text in the same session context

For supervisor-initiated builds:
1. `tgcc_session(action="new", prompt="...")` kicks off the worker
2. Reference images need to be in the worker's context — options:
   a. Save reference images to the repo and reference them in the spec
   b. Future: `tgcc_send` with image attachments from file paths

### Step 4: Spec-Aware Initial Prompt Template

Instead of "Check CLAUDE.md and your todo/backlog for the next task," use:

```
Read SPEC.md carefully — it is your primary source of truth. Study all phases in order.

DO NOT skip Phase 0 (Research). Complete each phase and its gate before moving to the next.

Your output will be judged against reference images and the spec's visual requirements, not just whether it "works."

Start with Phase 0 now.
```

## Usage Example: Super Off Road Redo

```
# 1. Save reference screenshots to the repo
cp ~/screenshots/super-off-road-*.png /home/fonz/Botverse/offroad/reference/

# 2. Update SPEC.md to reference them
echo "## Reference Images\nSee reference/ directory for target visual style." >> SPEC.md

# 3. Kick off with spec-aware prompt
tgcc_session(agentId="offroad", action="new", prompt="Read SPEC.md. Study the reference images in reference/. Your output must visually match the original game. Start with Phase 0 (Research). Do not skip to implementation.")

# 4. Ralph with spec
tgcc_ralph(agentId="offroad", prompt="Verify offroad builds a faithful Super Off Road remake per SPEC.md. After worker claims completion, open https://offroad.earth.fonz.io in the browser, screenshot it, and compare to reference/. If it doesn't look like the original (isometric view, sprite-based trucks, textured tracks), send the worker back with specific visual feedback. Do NOT sign off on flat 2D rectangles.")
```

## Metrics for Success

A spec-driven ralph session is successful when:
1. All spec phases are completed in order
2. Gate deliverables exist and are non-trivial
3. The deployed output visually matches reference images
4. Ralph's final verification screenshot shows faithful reproduction
5. Total cost stays under 2x what a non-ralph session would cost (the overhead of verification should be small relative to the work)
