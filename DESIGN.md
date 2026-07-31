---
name: Visual Remote Dev Bridge
description: A precise flight-strip console for selecting UI, dispatching code changes, and reviewing their safety.
colors:
  graphite: "#20211f"
  graphite-raised: "#30312e"
  strip: "#f4efe3"
  strip-strong: "#fffaf0"
  pure-white: "#ffffff"
  ink: "#1b1c1a"
  muted: "#64635b"
  rule: "#b7b0a1"
  dispatch: "#cf450f"
  dispatch-dark: "#9f3108"
  verified: "#087f8c"
  danger: "#a72920"
typography:
  body:
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.4
  title:
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    fontSize: "13px"
    fontWeight: 680
    lineHeight: 1.4
    letterSpacing: "-0.01em"
  control:
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    fontSize: "13px"
    fontWeight: 650
    lineHeight: 1.4
  label:
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    fontSize: "10px"
    fontWeight: 400
    lineHeight: 1.4
  machine:
    fontFamily: "ui-monospace, SFMono-Regular, Consolas, monospace"
    fontSize: "10px"
    fontWeight: 400
    lineHeight: 1.55
rounded:
  control: "3px"
  toolbar: "4px 4px 9px 4px"
  strip: "4px 4px 11px 4px"
spacing:
  tight: "4px"
  compact: "6px"
  small: "8px"
  medium: "10px"
  panel: "11px"
  viewport: "12px"
components:
  toolbar:
    backgroundColor: "{colors.graphite}"
    textColor: "{colors.strip-strong}"
    typography: "{typography.body}"
    rounded: "{rounded.toolbar}"
    padding: "{spacing.tight}"
    height: "38px"
  strip:
    backgroundColor: "{colors.strip}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.strip}"
    padding: "{spacing.panel}"
    width: "min(408px, calc(100vw - 24px))"
  request-field:
    backgroundColor: "{colors.strip-strong}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.control}"
    padding: "9px 10px"
    height: "86px"
  button-primary:
    backgroundColor: "{colors.dispatch}"
    textColor: "{colors.pure-white}"
    typography: "{typography.control}"
    rounded: "{rounded.control}"
    padding: "6px 11px"
    height: "34px"
  button-secondary:
    backgroundColor: "{colors.graphite-raised}"
    textColor: "{colors.strip-strong}"
    typography: "{typography.control}"
    rounded: "{rounded.control}"
    padding: "6px 11px"
    height: "34px"
  button-danger:
    backgroundColor: "transparent"
    textColor: "{colors.danger}"
    typography: "{typography.control}"
    rounded: "{rounded.control}"
    padding: "6px 11px"
    height: "34px"
  selection-reticle:
    textColor: "{colors.dispatch}"
---

# Design System: Visual Remote Dev Bridge

## Overview

**Creative North Star: "The Flight Strip Console"**

The Overlay behaves like an air-traffic flight-strip board placed temporarily over the application: compact task strips carry identity, intent, phase, and outcome without obscuring the scene underneath. The selected page element remains the “airspace”; the Bridge UI only introduces the controls needed to route one change safely from request to review.

The implemented system is operational rather than decorative. Dense information is aligned, machine facts use tabular numerals, and one active accent moves from selection to dispatch to progress. Matte surfaces, hard rules, asymmetric corners, and registration marks give it the character of physical control-room equipment without imitating a generic developer dashboard.

**Key Characteristics:**

- compact, asymmetrically rounded strips with stable alignment and tabular status data
- one dispatch-orange active signal with quieter queued and completed states
- double-line page-relative selection marks that remain legible over arbitrary sites
- step-based connection pulses and routed progress with a reduced-motion fallback

## Colors

The palette pairs warm paper strips with matte graphite equipment, then reserves saturated color for active dispatch, verified feedback, and danger.

### Primary

- **Dispatch Orange** (#cf450f): Marks the selected mode, selection reticle, active phase, progress route, and primary action while preserving AA contrast with white control text.
- **Dispatch Dark** (#9f3108): Provides the active signal’s structural border and the outer keyboard-focus backing ring.

### Secondary

- **Verification Cyan** (#087f8c): Identifies a connected Bridge, a terminal phase, and confirmed verification.
- **Danger Red** (#a72920): Identifies task errors and the explicit revert action, always with text or status context.

### Neutral

- **Matte Graphite** (#20211f): Grounds the toolbar, strip headers, selection labels, and diff surface.
- **Raised Graphite** (#30312e): Separates secondary actions from the warm strip body.
- **Warm Strip** (#f4efe3): Carries request, progress, and review content.
- **Strong Strip White** (#fffaf0): Carries fields, high-contrast marks, and light text over graphite.
- **Pure White** (#ffffff): Carries primary-action and selected-mode text where the active signal needs maximum contrast.
- **Instrument Ink** (#1b1c1a): Provides primary copy on warm surfaces.
- **Muted Ledger Gray** (#64635b): Carries helper text and secondary machine facts.
- **Strip Rule** (#b7b0a1): Separates readouts and review regions without introducing card stacks.

**The One Active Signal Rule.** Only the current task, selected mode, selection geometry, or primary action receives dispatch orange; queued, secondary, and completed controls remain neutral or verified.

## Typography

**Body Font:** Platform UI sans stack  
**Label/Mono Font:** Platform monospace stack for resolved machine facts

**Character:** Compact sans copy keeps requests and actions natural, while monospace data makes paths, task IDs, file counts, logs, and diffs read like aligned instruments rather than decoration.

### Hierarchy

- **Title** (680, 13px, 1.4, -0.01em): Strip titles and the strongest current-phase label.
- **Control** (650, 13px, 1.4): Buttons and actionable summaries.
- **Body** (400, 13px, 1.4): Request text, field content, and general operational copy.
- **Label** (400, 10px, 1.4): Scope labels, helper copy, status detail, and compact metadata.
- **Machine** (400, 10px, 1.55): Task codes, counts, file paths, log lines, and unified diff; tabular numerals are mandatory where values update.

**The Instrument Label Rule.** Monospace communicates machine-resolved facts; natural-language requests and actions stay in the UI sans face.

## Layout

The Overlay occupies a fixed, pointer-transparent viewport layer; only the centered toolbar and active strip accept input. The toolbar sits 12px from the safe top edge. A strip is at most 408px wide, keeps 12px of viewport clearance, and clamps or flips around the selected target so the page remains the dominant scene.

Inside a strip, content follows one scan: source header → selection or phase readout → request or logs → scope, verification, diff, and actions. The request metadata row uses a flexible column plus its dispatch action; review actions wrap in place rather than opening a second panel.

At 600px and below, the toolbar spans the viewport with 8px side insets, the brand mark disappears, the strip docks 8px from the sides and safe bottom edge, request metadata becomes one column, and the primary dispatch target grows from 34px to 44px high.

## Elevation & Depth

Depth is structural rather than atmospheric. The toolbar uses a 5px/18px shadow, the active strip a 7px/24px shadow, and the selection hint a 4px/14px shadow; opaque fills and crisp one-pixel borders carry contrast when shadows are unavailable. The reticle combines a two-pixel signal border, an offset one-pixel warm outline, and opposing graphite registration ticks. No backdrop blur is used.

### Shadow Vocabulary

- **Toolbar Lift** (`0 5px 18px rgb(0 0 0 / 28%)`): Separates the compact toolbar from an unknown host page.
- **Strip Lift** (`0 7px 24px rgb(0 0 0 / 30%)`): Lifts the active request, progress, or review strip.
- **Hint Lift** (`0 4px 14px rgb(0 0 0 / 24%)`): Keeps the transient selection hint legible over page content.
- **Focus Backstop** (`0 0 0 5px #9f3108`): Backs the warm three-pixel outline on keyboard targets.

**The Host Independence Rule.** Every Overlay surface, selection mark, and focus state remains readable when the host page is pure white or pure black.

## Shapes

Controls use a precise 3px radius. The toolbar uses asymmetric corners (4px 4px 9px 4px), while strips use a slightly stronger clipped-tail silhouette (4px 4px 11px 4px). Connection dots, phase marks, and the brand signal remain square; status is never turned into a pill. Reticle registration ticks indicate target geometry without filling or covering the selected element.

## Components

### Mode Toolbar

The 38px-high graphite toolbar groups the brand signal, four selection modes, and a labeled connection state. Mode buttons are 28px high on desktop and 36px high on compact viewports; only the pressed mode uses dispatch orange.

### Flight Strip

The strip is a single reusable request, progress, and review container. Its graphite 34px header fixes source or task identity at the top, while an 11px-padded warm body changes phase without moving to a new surface.

### Request Field

The strong-strip textarea starts at 86px high, resizes vertically to 180px, and uses a one-pixel neutral border. Keyboard focus adds a three-pixel warm outline and a five-pixel dispatch-dark backing ring; IME-safe Enter behavior is part of the component contract.

### Buttons

- **Primary:** Dispatch orange with pure-white text, a dispatch-dark border, 34px minimum height, and 6px 11px padding.
- **Secondary:** Raised graphite with warm-white text and a near-black border at the same dimensions.
- **Quiet:** Transparent instrument ink for cancellation and low-emphasis actions.
- **Danger:** Transparent danger-red text and border; its pale-red hover surface never removes the explicit “되돌리기” label.

### Status and Review

Square phase marks pair with a textual phase and file count. A three-pixel route track shows active work; terminal work fills the track in verification cyan. Review uses a warm file ledger, a bordered verification block, and a graphite monospace diff surface within the same strip.

### Selection Reticle

The selected target receives the dispatch border and warm outer line; hover uses a graphite border. Multi-target labels are compact graphite machine tags, and region selection changes the signal border to dashed with an eight-percent dispatch wash.

## Do's and Don'ts

### Do:

- Do reserve dispatch orange for the selected mode, active route, reticle, and primary action.
- Do keep the three-pixel warm outline plus five-pixel dispatch-dark backing ring on every keyboard target.
- Do preserve pointer transparency outside the toolbar and active strip so the host page remains usable.
- Do stop connection and route animations under `prefers-reduced-motion: reduce`.

### Don't:

- Don't add gradients, glow, or blur-dependent glass to Overlay surfaces.
- Don't turn three-pixel controls, square state marks, or review blocks into pill-shaped UI.
- Don't encode connection, phase, verification, or danger using color without a label or icon.
- Don't let host-page styles leak into the Shadow DOM or replace the Overlay’s explicit contrast.
