/** Shadow-root styles for the injected Overlay client. */
import { visualBridgeColorTokens } from "./design-tokens.js";

export const overlayStyles = String.raw`
  :host {
    all: initial;
    position: fixed;
    inset: 0;
    z-index: 2147483647;
    pointer-events: none;
    color-scheme: light;
    contain: layout style;
  }

  *, *::before, *::after {
    box-sizing: border-box;
  }

  button, textarea, select {
    font: inherit;
  }

  button, select {
    margin: 0;
  }

  .visual-shell {
    ${visualBridgeColorTokens}
    position: fixed;
    inset: 0;
    color: var(--ink);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    font-size: 13px;
    line-height: 1.4;
    pointer-events: none;
    text-rendering: optimizeLegibility;
  }

  .visual-shell[data-open="false"] {
    pointer-events: none;
  }

  .visual-shell[data-open="false"] > :not(.task-compact):not(.visually-hidden) {
    visibility: hidden;
  }

  .visual-shell[data-open="true"] .toolbar,
  .visual-shell[data-open="true"] .strip,
  .task-compact {
    pointer-events: auto;
  }

  .toolbar {
    position: fixed;
    top: max(12px, env(safe-area-inset-top));
    left: 50%;
    display: flex;
    align-items: stretch;
    min-height: 38px;
    padding: 4px;
    background: var(--graphite);
    border: 1px solid #080907;
    border-radius: 4px 4px 9px 4px;
    box-shadow: 0 5px 18px rgb(0 0 0 / 28%);
    transform: translateX(-50%);
    color: #f9f4e9;
  }

  .brand-mark {
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 0 10px 0 7px;
    border-right: 1px solid #4a4b46;
    white-space: nowrap;
    font-weight: 650;
    letter-spacing: -0.01em;
  }

  .brand-mark::before {
    width: 8px;
    height: 8px;
    content: "";
    background: var(--dispatch);
    border: 1px solid #ffb58e;
  }

  .mode-tabs {
    display: flex;
    gap: 2px;
    margin-left: 4px;
  }

  .toolbar button,
  .toolbar a,
  .toolbar .connection {
    min-height: 28px;
    border: 1px solid transparent;
    border-radius: 3px;
    background: transparent;
    color: #ded9cf;
  }

  .toolbar button,
  .toolbar a {
    display: flex;
    align-items: center;
    justify-content: center;
    min-width: 48px;
    padding: 4px 9px;
    cursor: pointer;
    text-decoration: none;
  }

  .toolbar button:hover,
  .toolbar a:hover {
    background: #3a3b37;
    color: #fffaf0;
  }

  .toolbar button[aria-pressed="true"] {
    background: var(--dispatch);
    border-color: #f18755;
    color: #fff;
    font-weight: 700;
  }

  .toolbar button:disabled {
    cursor: not-allowed;
    opacity: 0.48;
  }

  .task-toggle,
  .viewer-link {
    margin-left: 4px;
    white-space: nowrap;
  }

  .connection {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-left: 5px;
    padding: 4px 8px;
    border-left-color: #4a4b46 !important;
    border-radius: 0 !important;
    color: #c5c1b8 !important;
    font-size: 11px;
    white-space: nowrap;
  }

  .connection-label-compact {
    display: none;
  }

  .task-compact {
    position: fixed;
    top: max(62px, calc(env(safe-area-inset-top) + 50px));
    right: 12px;
    z-index: 4;
    display: flex;
    width: min(360px, calc(100vw - 24px));
    min-height: 48px;
    overflow: hidden;
    background: var(--strip);
    border: 1px solid #272821;
    border-radius: 4px 4px 11px 4px;
    box-shadow: 0 5px 18px rgb(0 0 0 / 28%);
    color: var(--ink);
  }

  .task-compact::after {
    position: absolute;
    right: 0;
    bottom: 0;
    left: 0;
    height: 2px;
    content: "";
    background: var(--verified);
  }

  .task-compact[data-active="true"]::after {
    width: 36%;
    background: var(--dispatch);
    animation: task-route 1.25s cubic-bezier(.16, 1, .3, 1) infinite;
  }

  .task-compact[data-error="true"]::after {
    width: 100%;
    background: var(--danger);
    animation: none;
  }

  .task-compact-main {
    display: grid;
    flex: 1;
    grid-template-columns: auto minmax(0, 1fr);
    align-items: center;
    gap: 8px;
    min-width: 0;
    min-height: 48px;
    padding: 6px 9px 7px 10px;
    border: 0;
    background: transparent;
    color: var(--ink);
    cursor: pointer;
    text-align: left;
  }

  .task-compact-main:hover {
    background: var(--strip-strong);
  }

  .task-compact-copy {
    display: grid;
    gap: 1px;
    min-width: 0;
  }

  .task-compact-copy strong,
  .task-compact-request {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .task-compact-copy strong {
    font-size: 12px;
  }

  .task-compact-request {
    color: var(--muted);
    font-size: 12px;
    line-height: 1.35;
  }

  .task-compact-cancel {
    align-self: stretch;
    min-width: 52px;
    padding: 0 9px;
    border: 0;
    border-left: 1px solid var(--rule);
    background: transparent;
    color: var(--danger);
    cursor: pointer;
    font-weight: 650;
  }

  .task-compact-cancel:hover {
    background: #f7dfdb;
  }

  .state-dot {
    width: 7px;
    height: 7px;
    border: 1px solid currentColor;
    background: currentColor;
  }

  .state-dot[data-state="connected"] {
    color: var(--verified);
  }

  .state-dot[data-state="connecting"],
  .state-dot[data-state="reconnecting"] {
    color: #e1a14a;
    animation: dispatch-tick 1.1s steps(2, end) infinite;
  }

  .state-dot[data-state="offline"],
  .state-dot[data-state="unauthorized"],
  .state-dot[data-state="unpaired"] {
    color: #d25b51;
  }

  .reticle {
    position: fixed;
    z-index: 1;
    border: 2px solid var(--dispatch);
    outline: 1px solid #fffaf0;
    outline-offset: 2px;
    pointer-events: none;
  }

  .reticle::before,
  .reticle::after {
    position: absolute;
    width: 9px;
    height: 9px;
    content: "";
    border-color: var(--graphite);
    border-style: solid;
  }

  .reticle::before {
    top: -5px;
    left: -5px;
    border-width: 2px 0 0 2px;
  }

  .reticle::after {
    right: -5px;
    bottom: -5px;
    border-width: 0 2px 2px 0;
  }

  .reticle[data-kind="hover"] {
    border-color: #343530;
    outline-color: #fffaf0;
  }

  .reticle-label {
    position: absolute;
    top: -22px;
    left: -2px;
    min-width: 20px;
    height: 18px;
    padding: 1px 5px;
    background: var(--graphite);
    border: 1px solid #fffaf0;
    color: #fffaf0;
    font: 700 11px/14px ui-monospace, SFMono-Regular, Consolas, monospace;
    text-align: center;
  }

  .region-box {
    position: fixed;
    z-index: 1;
    border: 2px dashed var(--dispatch);
    outline: 1px solid #fffaf0;
    outline-offset: 2px;
    background: rgb(207 69 15 / 8%);
    pointer-events: none;
  }

  .region-box-label {
    position: absolute;
    top: 5px;
    left: 5px;
    padding: 2px 5px;
    border: 1px solid #fffaf0;
    background: var(--graphite);
    color: #fffaf0;
    font-size: 10px;
    line-height: 1.4;
  }

  .strip {
    position: fixed;
    z-index: 3;
    display: flex;
    flex-direction: column;
    width: min(408px, calc(100vw - 24px));
    max-height: calc(100vh - 76px);
    overflow: auto;
    background: var(--strip);
    border: 1px solid #272821;
    border-radius: 4px 4px 11px 4px;
    box-shadow: 0 7px 24px rgb(0 0 0 / 30%);
    color: var(--ink);
  }

  .strip-head {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: center;
    min-height: 34px;
    padding: 6px 9px 6px 11px;
    background: var(--graphite);
    color: #f8f3e9;
  }

  .strip-title {
    min-width: 0;
    overflow: hidden;
    font-weight: 680;
    letter-spacing: -0.01em;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .machine {
    font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
    font-variant-numeric: tabular-nums;
  }

  .strip-code {
    margin-left: 10px;
    color: #bdb9b0;
    font-size: 10px;
  }

  .strip-body {
    min-height: 0;
    padding: 11px;
    overflow: auto;
  }

  .selection-readout {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    min-height: 25px;
    margin-bottom: 8px;
    padding-bottom: 8px;
    border-bottom: 1px solid var(--rule);
    color: var(--muted);
    font-size: 11px;
  }

  .selection-readout strong {
    min-width: 0;
    overflow: hidden;
    color: var(--ink);
    font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
    font-weight: 650;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .target-readout {
    margin-bottom: 8px;
    padding-bottom: 8px;
    border-bottom: 1px solid var(--rule);
  }

  .target-source-line {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(84px, auto);
    align-items: baseline;
    gap: 8px;
    min-height: 25px;
  }

  .target-source-line strong,
  .target-source-line span {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .target-source-line strong {
    font: 650 11px/1.45 ui-monospace, SFMono-Regular, Consolas, monospace;
  }

  .target-source-line span {
    max-width: 164px;
    color: var(--muted);
    font-size: 10px;
    text-align: right;
  }

  .target-source-line[data-pending="true"] strong {
    font-family: inherit;
  }

  .target-details {
    border-top: 1px dashed #c8c0b2;
  }

  .target-details summary {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 28px;
    padding: 5px 1px 0;
    color: var(--muted);
    cursor: pointer;
    font-size: 10px;
    font-weight: 650;
  }

  .target-details summary span {
    margin-left: auto;
    color: var(--muted);
    font-weight: 400;
  }

  .target-detail-body {
    padding-top: 7px;
  }

  .target-detail-body code {
    display: block;
    max-height: 112px;
    overflow: auto;
    color: #4f4f49;
    font: 10px/1.55 ui-monospace, SFMono-Regular, Consolas, monospace;
    overflow-wrap: anywhere;
    white-space: pre-wrap;
  }

  .target-copy-row {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 7px;
  }

  .copy-status {
    min-width: 0;
    color: var(--muted);
    font-size: 10px;
  }

  .request-field {
    display: block;
    width: 100%;
    min-height: 86px;
    max-height: 180px;
    resize: vertical;
    padding: 9px 10px;
    border: 1px solid #888276;
    border-radius: 3px;
    outline: none;
    background: var(--strip-strong);
    color: var(--ink);
    line-height: 1.5;
  }

  .request-field::placeholder {
    color: #706e67;
  }

  .request-field:focus-visible,
  select:focus-visible,
  button:focus-visible,
  .toolbar a:focus-visible,
  summary:focus-visible {
    outline: 3px solid #fffaf0;
    outline-offset: 2px;
    box-shadow: 0 0 0 5px var(--dispatch-dark);
  }

  .request-meta {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: end;
    gap: 10px;
    margin-top: 9px;
  }

  .field-label {
    display: grid;
    gap: 3px;
    color: var(--muted);
    font-size: 10px;
  }

  select {
    min-height: 34px;
    padding: 5px 28px 5px 8px;
    border: 1px solid #888276;
    border-radius: 3px;
    background: var(--strip-strong);
    color: var(--ink);
    cursor: pointer;
  }

  .primary,
  .secondary,
  .danger,
  .quiet {
    min-height: 34px;
    padding: 6px 11px;
    border: 1px solid #777268;
    border-radius: 3px;
    cursor: pointer;
    font-weight: 650;
  }

  .primary {
    background: var(--dispatch);
    border-color: var(--dispatch-dark);
    color: #fff;
  }

  .primary:hover {
    background: #bd3d0d;
  }

  .secondary {
    background: var(--graphite-2);
    border-color: #11120f;
    color: #fffaf0;
  }

  .secondary:hover {
    background: #464741;
  }

  .quiet {
    background: transparent;
    color: var(--ink);
  }

  .quiet:hover {
    background: #e4ded2;
  }

  .danger {
    background: transparent;
    border-color: var(--danger);
    color: var(--danger);
  }

  .danger:hover {
    background: #f8dfdb;
  }

  button:disabled {
    cursor: not-allowed;
    opacity: 0.52;
  }

  .shortcut-note,
  .input-note {
    color: var(--muted);
    font-size: 10px;
  }

  .input-note {
    margin: 6px 0 0;
  }

  .status-row {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    align-items: center;
    gap: 8px;
    padding-bottom: 9px;
    border-bottom: 1px solid var(--rule);
  }

  .phase-mark {
    width: 10px;
    height: 10px;
    background: var(--dispatch);
    border: 1px solid var(--dispatch-dark);
  }

  .phase-mark[data-terminal="true"] {
    background: var(--verified);
    border-color: #075e68;
  }

  .phase-mark[data-error="true"] {
    background: var(--danger);
    border-color: #711912;
  }

  .phase-mark[data-state="canceled"] {
    background: #777268;
    border-color: #4f4c46;
  }

  .phase-copy {
    display: grid;
    min-width: 0;
  }

  .phase-copy strong {
    letter-spacing: -0.01em;
  }

  .phase-copy span {
    overflow: hidden;
    color: var(--muted);
    font-size: 10px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .phase-count {
    color: var(--muted);
    font-size: 10px;
  }

  .progress-track {
    height: 3px;
    margin: 8px 0 10px;
    overflow: hidden;
    background: #d4cec1;
  }

  .progress-track span {
    display: block;
    width: 32%;
    height: 100%;
    background: var(--dispatch);
    animation: task-route 1.25s cubic-bezier(.16, 1, .3, 1) infinite;
  }

  .progress-track[data-active="false"] span {
    width: 100%;
    animation: none;
    background: #777268;
  }

  .progress-track[data-outcome="complete"] span {
    background: var(--verified);
  }

  .progress-track[data-outcome="error"] span {
    background: var(--danger);
  }

  .log-summary {
    display: grid;
    gap: 4px;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .log-summary li {
    display: grid;
    grid-template-columns: 13px minmax(0, 1fr);
    gap: 5px;
    color: #4f4f49;
    font: 11px/1.45 ui-monospace, SFMono-Regular, Consolas, monospace;
  }

  .log-summary li::before {
    content: "›";
    color: var(--dispatch-dark);
  }

  .empty-line {
    margin: 7px 0;
    color: var(--muted);
    font-size: 11px;
  }

  .error-banner {
    margin: 8px 0 0;
    padding: 7px 8px;
    border: 1px solid var(--danger);
    background: #f7dfdb;
    color: #741a13;
    font-size: 11px;
  }

  .review-summary {
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 8px;
    margin-top: 10px;
  }

  .file-list {
    display: grid;
    gap: 4px;
    max-height: 86px;
    margin: 0;
    padding: 7px 8px;
    overflow: auto;
    border: 1px solid var(--rule);
    background: #e9e2d5;
    list-style: none;
  }

  .file-list li {
    overflow: hidden;
    font: 10px/1.4 ui-monospace, SFMono-Regular, Consolas, monospace;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .verification {
    display: grid;
    align-content: start;
    gap: 3px;
    min-width: 104px;
    padding: 7px 8px;
    border: 1px solid #888276;
    background: #e9e2d5;
    color: var(--ink);
    font-size: 10px;
  }

  .verification[data-status="passed"] {
    border-color: #17727b;
    background: #dcebed;
    color: #075a63;
  }

  .verification[data-status="partial"] {
    border-color: #8a5b14;
    background: #f1e4cc;
    color: #5f3e0d;
  }

  .verification[data-status="failed"] {
    border-color: var(--danger);
    background: #f7dfdb;
    color: #741a13;
  }

  .verification strong {
    font-size: 11px;
  }

  details.diff {
    margin-top: 8px;
    border-top: 1px solid var(--rule);
  }

  details.diff summary {
    padding: 8px 1px 1px;
    cursor: pointer;
    font-weight: 650;
  }

  .diff-code {
    max-height: min(270px, 38vh);
    margin: 7px -3px 0;
    padding: 9px;
    overflow: auto;
    border: 1px solid #4b4b45;
    background: #1f201e;
    color: #f2eee4;
    font: 10px/1.55 ui-monospace, SFMono-Regular, Consolas, monospace;
    tab-size: 2;
    white-space: pre;
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-top: 10px;
  }

  .actions .danger {
    margin-left: auto;
  }

  .follow-up {
    display: grid;
    gap: 7px;
    margin-top: 10px;
    padding-top: 10px;
    border-top: 1px solid var(--rule);
  }

  .follow-up textarea {
    min-height: 66px;
  }

  .selection-hint {
    position: fixed;
    bottom: max(14px, env(safe-area-inset-bottom));
    left: 50%;
    padding: 6px 9px;
    background: var(--graphite);
    border: 1px solid #0b0c0a;
    border-radius: 3px;
    box-shadow: 0 4px 14px rgb(0 0 0 / 24%);
    transform: translateX(-50%);
    color: #f8f3e9;
    font-size: 11px;
    white-space: nowrap;
  }

  .visually-hidden {
    position: absolute !important;
    width: 1px !important;
    height: 1px !important;
    padding: 0 !important;
    overflow: hidden !important;
    clip: rect(0, 0, 0, 0) !important;
    white-space: nowrap !important;
    border: 0 !important;
  }

  @keyframes dispatch-tick {
    50% { opacity: 0.35; }
  }

  @keyframes task-route {
    from { transform: translateX(-105%); }
    to { transform: translateX(315%); }
  }

  @media (max-width: 600px) {
    .toolbar {
      right: 8px;
      left: 8px;
      overflow-x: auto;
      transform: none;
    }

    .brand-mark {
      display: none;
    }

    .toolbar button,
    .toolbar a {
      min-width: 46px;
      min-height: 44px;
    }

    .task-compact {
      top: max(66px, calc(env(safe-area-inset-top) + 58px));
      right: 8px;
      left: 8px;
      width: auto;
    }

    .connection {
      margin-left: auto;
      padding-right: 6px;
      padding-left: 6px;
    }

    .connection-label-full {
      display: none;
    }

    .connection-label-compact {
      display: inline;
    }

    .strip {
      right: 8px !important;
      bottom: max(8px, env(safe-area-inset-bottom)) !important;
      left: 8px !important;
      top: auto !important;
      width: auto;
      max-height: calc(100vh - 74px - env(safe-area-inset-bottom));
      overflow: auto;
    }

    .request-meta {
      grid-template-columns: 1fr;
    }

    .request-meta .primary {
      min-height: 44px;
    }

    .target-details summary,
    .target-copy {
      min-height: 44px;
    }

    .selection-hint {
      bottom: calc(10px + env(safe-area-inset-bottom));
      max-width: calc(100vw - 20px);
      overflow: hidden;
      text-overflow: ellipsis;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .state-dot,
    .progress-track span {
      animation: none !important;
    }
  }
`;
