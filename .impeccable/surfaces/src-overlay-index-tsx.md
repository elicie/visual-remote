---
version: 1
slug: "src-overlay-index-tsx"
primary_target: "packages/overlay/src/index.tsx"
related_targets: ["packages/overlay/src/styles.ts","packages/overlay/src/helpers.ts"]
---

# Overlay Surface Brief

- Scope and mode: repository-injected browser Overlay; Operate.
- Audience and job: a developer inspecting a live remote app must point at rendered UI, state one change, and stay oriented while the repository agent works.
- Primary task: select one element, several elements, a region, or the page; dispatch a scoped request; review phase, files, verification, and diff; then keep, revert, or follow up.
- Proof and content: resolved source hints, explicit task phases, bounded logs, changed-file ledger, unified diff, and verification status are the evidence.
- Constraints: the host page remains primary and usable; Shadow DOM isolation, viewport clamping, keyboard access, Korean IME safety, reduced motion, same-origin pairing, and explicit uncertainty are non-negotiable.
- Chosen direction: Flight Strip Console, staged as one compact operational strip anchored near the selected target instead of a detached dashboard.
- Memorable moment: dispatch-orange target registration marks visually route into the single strip, whose progress line becomes verification cyan when the change reaches review.
- Unresolved decisions: real-project field testing may refine source-confidence copy and compact-viewport docking, without changing the single-strip interaction model.
