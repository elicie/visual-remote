/** Standalone task-viewer styles. */
import { visualBridgeColorTokens } from "./design-tokens.js";

export const viewerStyles = String.raw`
  :root {
    color-scheme: light;
    ${visualBridgeColorTokens}
    --canvas: #ded8cc;
  }

  * {
    box-sizing: border-box;
  }

  html {
    min-width: 320px;
    min-height: 100%;
    background: var(--canvas);
  }

  body {
    min-width: 320px;
    min-height: 100vh;
    margin: 0;
    background: var(--canvas);
    color: var(--ink);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    font-size: 13px;
    line-height: 1.4;
    text-rendering: optimizeLegibility;
  }

  button {
    margin: 0;
    font: inherit;
  }

  button:focus-visible,
  a:focus-visible {
    outline: 3px solid var(--strip-strong);
    outline-offset: 2px;
    box-shadow: 0 0 0 5px var(--dispatch-dark);
  }

  .detail-scroll:focus-visible,
  .logs-block ol:focus-visible,
  .diff-block pre:focus-visible {
    outline: 3px solid var(--dispatch);
    outline-offset: -3px;
  }

  .visually-hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    overflow: hidden;
    clip: rect(0 0 0 0);
    clip-path: inset(50%);
    border: 0;
    white-space: nowrap;
  }

  .machine {
    font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
    font-variant-numeric: tabular-nums;
  }

  .viewer-app {
    min-height: 100vh;
  }

  .viewer-header {
    position: sticky;
    z-index: 10;
    top: 0;
    display: flex;
    align-items: stretch;
    justify-content: space-between;
    min-height: 58px;
    padding: 0 max(22px, calc((100vw - 1440px) / 2));
    border-bottom: 1px solid #080907;
    background: var(--graphite);
    color: var(--strip-strong);
  }

  .viewer-app[data-loading="true"] .viewer-header::after {
    position: absolute;
    right: 0;
    bottom: -1px;
    left: 0;
    height: 3px;
    content: "";
    background: var(--dispatch);
    transform-origin: left;
    animation: viewer-load 1.2s cubic-bezier(.16, 1, .3, 1) infinite;
  }

  .viewer-brand {
    display: flex;
    align-items: center;
    gap: 10px;
    min-width: 190px;
    padding: 0 18px 0 2px;
    border-right: 1px solid #4a4b46;
  }

  .brand-signal {
    width: 10px;
    height: 10px;
    border: 1px solid #ffb58e;
    background: var(--dispatch);
  }

  .viewer-brand > span:last-child {
    display: grid;
  }

  .viewer-brand strong {
    letter-spacing: -0.01em;
  }

  .viewer-brand small {
    color: #bdb9b0;
    font-size: 10px;
  }

  .header-instruments {
    display: flex;
    align-items: stretch;
  }

  .project-readout,
  .connection-readout,
  .refresh-readout {
    display: grid;
    align-content: center;
    min-width: 152px;
    padding: 8px 16px;
    border-left: 1px solid #4a4b46;
  }

  .project-readout small,
  .connection-readout small,
  .refresh-readout small {
    color: #aaa69e;
    font: 9px/1.4 ui-monospace, SFMono-Regular, Consolas, monospace;
  }

  .project-readout strong,
  .connection-readout strong,
  .refresh-readout strong {
    overflow: hidden;
    color: #f6f0e5;
    font: 650 11px/1.4 ui-monospace, SFMono-Regular, Consolas, monospace;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .connection-readout {
    min-width: 116px;
  }

  .connection-readout strong {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .connection-readout strong > span {
    width: 8px;
    height: 8px;
    border: 1px solid #77786f;
    background: #77786f;
  }

  .connection-readout[data-state="connected"] strong > span {
    border-color: #4fc4d0;
    background: var(--verified);
  }

  .connection-readout[data-state="connecting"] strong > span,
  .connection-readout[data-state="reconnecting"] strong > span {
    border-color: #f18755;
    background: var(--dispatch);
  }

  .connection-readout[data-state="offline"] strong > span,
  .connection-readout[data-state="unauthorized"] strong > span {
    border-color: #e17e75;
    background: var(--danger);
  }

  .refresh-button {
    align-self: center;
    min-height: 38px;
    margin-left: 10px;
    padding: 6px 12px;
    border: 1px solid #5d5e58;
    border-radius: 3px;
    background: var(--graphite-2);
    color: var(--strip-strong);
    cursor: pointer;
    font-weight: 650;
  }

  .refresh-button:hover {
    background: #464741;
  }

  .refresh-button:disabled {
    cursor: wait;
    opacity: 0.6;
  }

  .viewer-main {
    width: min(1440px, calc(100% - 44px));
    margin: 0 auto;
    padding: 24px 0 32px;
  }

  .viewer-intro {
    display: flex;
    align-items: end;
    justify-content: space-between;
    gap: 24px;
    margin-bottom: 17px;
  }

  .viewer-intro h1 {
    margin: 0 0 4px;
    font-size: clamp(24px, 3vw, 38px);
    line-height: 1.08;
    letter-spacing: -0.03em;
  }

  .viewer-intro p {
    max-width: 68ch;
    margin: 0;
    color: #53534d;
  }

  .read-only-mark {
    flex: none;
    padding: 5px 7px;
    border: 1px solid #777268;
    color: #53534d;
    font: 10px/1 ui-monospace, SFMono-Regular, Consolas, monospace;
  }

  .status-rail {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    margin-bottom: 12px;
    border: 1px solid #272821;
    border-radius: 4px 4px 9px 4px;
    background: var(--graphite);
    overflow: hidden;
  }

  .status-rail button {
    display: flex;
    align-items: center;
    justify-content: space-between;
    min-height: 46px;
    padding: 8px 12px;
    border: 0;
    border-right: 1px solid #4a4b46;
    background: transparent;
    color: #d7d2c8;
    cursor: pointer;
    text-align: left;
  }

  .status-rail button > span {
    white-space: nowrap;
  }

  .status-rail button:last-child {
    border-right: 0;
  }

  .status-rail button:hover {
    background: #393a36;
    color: var(--strip-strong);
  }

  .status-rail button[aria-pressed="true"] {
    background: var(--dispatch);
    color: #fff;
    font-weight: 700;
  }

  .status-rail button strong {
    font-size: 16px;
  }

  .viewer-error,
  .detail-error {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 9px 10px;
    border: 1px solid var(--danger);
    background: #f7dfdb;
    color: #741a13;
  }

  .viewer-error {
    margin-bottom: 12px;
  }

  .viewer-error button,
  .detail-error button {
    flex: none;
    min-height: 38px;
    padding: 4px 9px;
    border: 1px solid var(--danger);
    border-radius: 3px;
    background: var(--strip-strong);
    color: var(--danger);
    cursor: pointer;
    font-weight: 650;
  }

  .operations-board {
    display: grid;
    grid-template-columns: minmax(300px, 360px) minmax(0, 1fr);
    height: clamp(520px, calc(100vh - 214px), 820px);
    min-height: 0;
    overflow: hidden;
    border: 1px solid #272821;
    border-radius: 4px 4px 11px 4px;
    background: var(--strip);
    box-shadow: 0 8px 26px rgb(0 0 0 / 24%);
  }

  .task-ledger {
    display: flex;
    min-width: 0;
    min-height: 0;
    flex-direction: column;
    border-right: 1px solid #272821;
    background: var(--strip);
  }

  .board-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    min-height: 62px;
    padding: 10px 12px;
    border-bottom: 1px solid var(--rule);
  }

  .board-head h2,
  .board-head p {
    margin: 0;
  }

  .board-head h2 {
    font-size: 14px;
    letter-spacing: -0.01em;
  }

  .board-head p,
  .board-head-tools > span {
    color: var(--muted);
    font-size: 10px;
  }

  .board-head-tools {
    display: grid;
    flex: none;
    justify-items: end;
    gap: 2px;
  }

  .detail-jump {
    color: var(--dispatch-dark);
    font-size: 10px;
    font-weight: 650;
    text-underline-offset: 2px;
  }

  .ledger-search {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: center;
    gap: 8px;
    padding: 8px 10px;
    border-bottom: 1px solid var(--rule);
    background: #e8e2d6;
  }

  .ledger-search label {
    min-width: 0;
  }

  .ledger-search input {
    width: 100%;
    min-height: 36px;
    padding: 7px 9px;
    border: 1px solid #8e897e;
    border-radius: 3px;
    background: var(--strip-strong);
    color: var(--ink);
  }

  .ledger-search input::placeholder {
    color: #69675f;
  }

  .ledger-search input:focus-visible {
    outline: 3px solid var(--strip-strong);
    outline-offset: 2px;
    box-shadow: 0 0 0 5px var(--dispatch-dark);
  }

  .ledger-search > span {
    color: var(--muted);
    font-size: 9px;
    white-space: nowrap;
  }

  .task-list {
    flex: 1;
    min-height: 0;
    margin: 0;
    padding: 0;
    overflow: auto;
    list-style: none;
  }

  .ledger-footer {
    flex: none;
    padding: 8px 10px;
    border-top: 1px solid var(--rule);
    background: #e8e2d6;
    text-align: center;
  }

  .ledger-footer button {
    width: 100%;
    min-height: 38px;
    border: 1px solid #777268;
    border-radius: 3px;
    background: var(--strip-strong);
    color: var(--ink);
    cursor: pointer;
    font-weight: 650;
  }

  .ledger-footer button:hover {
    border-color: var(--dispatch-dark);
    color: var(--dispatch-dark);
  }

  .ledger-footer button:disabled {
    cursor: wait;
    opacity: .65;
  }

  .ledger-end {
    color: var(--muted);
    font-size: 10px;
  }

  .detail-alerts {
    display: grid;
    gap: 7px;
    margin-bottom: 10px;
  }

  .detail-alerts .detail-error {
    margin: 0;
  }

  .task-row {
    position: relative;
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    align-items: center;
    gap: 9px;
    width: 100%;
    min-height: 66px;
    padding: 9px 11px;
    border: 0;
    border-bottom: 1px solid var(--rule);
    background: transparent;
    color: var(--ink);
    cursor: pointer;
    text-align: left;
  }

  .task-row:hover {
    background: #ebe5d9;
  }

  .task-row[aria-current="true"] {
    background: var(--strip-strong);
    box-shadow: inset 3px 0 0 var(--dispatch);
  }

  .task-state {
    width: 10px;
    height: 10px;
    border: 1px solid #075e68;
    background: var(--verified);
  }

  .task-row[data-tone="active"] .task-state,
  .detail-status[data-tone="active"] > span {
    border-color: var(--dispatch-dark);
    background: var(--dispatch);
  }

  .task-row[data-tone="review"] .task-state,
  .detail-status[data-tone="review"] > span {
    border-color: #8a5b14;
    background: #c8861d;
  }

  .task-row[data-tone="issue"] .task-state,
  .detail-status[data-tone="issue"] > span {
    border-color: #711912;
    background: var(--danger);
  }

  .task-copy {
    display: grid;
    min-width: 0;
    gap: 2px;
  }

  .task-copy strong,
  .task-copy > span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .task-copy strong {
    font-weight: 650;
    letter-spacing: -0.01em;
  }

  .task-copy > span {
    color: var(--muted);
    font-size: 10px;
  }

  .task-meta {
    display: grid;
    justify-items: end;
    gap: 2px;
    color: var(--muted);
    font-size: 9px;
  }

  .ledger-state,
  .detail-empty {
    display: grid;
    place-content: center;
    justify-items: center;
    min-height: 220px;
    padding: 28px;
    text-align: center;
  }

  .ledger-state {
    flex: 1;
  }

  .ledger-state strong,
  .detail-empty strong {
    margin-bottom: 4px;
  }

  .ledger-state span,
  .detail-empty p {
    max-width: 48ch;
    margin: 0;
    color: var(--muted);
    font-size: 11px;
  }

  .task-detail {
    display: flex;
    min-width: 0;
    min-height: 0;
    flex-direction: column;
    background: var(--strip-strong);
  }

  .task-detail:focus {
    outline: 3px solid var(--dispatch);
    outline-offset: -3px;
  }

  .detail-empty {
    flex: 1;
  }

  .empty-reticle {
    position: relative;
    width: 34px;
    height: 34px;
    margin-bottom: 12px;
    border: 2px solid var(--dispatch);
    outline: 1px solid var(--graphite);
    outline-offset: 3px;
  }

  .empty-reticle::before,
  .empty-reticle::after {
    position: absolute;
    width: 8px;
    height: 8px;
    content: "";
    border-color: var(--graphite);
    border-style: solid;
  }

  .empty-reticle::before {
    top: -5px;
    left: -5px;
    border-width: 2px 0 0 2px;
  }

  .empty-reticle::after {
    right: -5px;
    bottom: -5px;
    border-width: 0 2px 2px 0;
  }

  .detail-head {
    display: flex;
    align-items: start;
    justify-content: space-between;
    gap: 24px;
    min-height: 92px;
    padding: 15px 17px 13px;
    border-bottom: 1px solid var(--rule);
    background: var(--graphite);
    color: var(--strip-strong);
  }

  .detail-kicker {
    color: #bdb9b0;
    font-size: 9px;
  }

  .detail-head h2 {
    max-width: 70ch;
    margin: 4px 0 0;
    font-size: clamp(16px, 1.7vw, 22px);
    line-height: 1.3;
    letter-spacing: -0.02em;
  }

  .detail-status {
    display: flex;
    flex: none;
    align-items: center;
    gap: 7px;
    padding-top: 2px;
    color: #ded9cf;
    font-size: 11px;
  }

  .detail-status > span {
    width: 9px;
    height: 9px;
    border: 1px solid #075e68;
    background: var(--verified);
  }

  .fact-strip {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    margin: 0;
    border-bottom: 1px solid var(--rule);
    background: var(--strip);
  }

  .fact-strip > div {
    min-width: 0;
    padding: 9px 12px;
    border-right: 1px solid var(--rule);
  }

  .fact-strip > div:last-child {
    border-right: 0;
  }

  .fact-strip dt {
    color: var(--muted);
    font-size: 9px;
  }

  .fact-strip dd {
    margin: 2px 0 0;
    overflow: hidden;
    font-weight: 650;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .detail-scroll {
    min-height: 0;
    padding: 14px;
    overflow: auto;
    scrollbar-gutter: stable;
  }

  .detail-error {
    margin-bottom: 12px;
  }

  .detail-error > span:first-child,
  .detail-error > strong + span {
    min-width: 0;
    overflow-wrap: anywhere;
  }

  .files-block,
  .logs-block,
  .diff-block {
    border: 1px solid var(--rule);
    background: var(--strip);
  }

  .files-block > header,
  .logs-block > header,
  .diff-block > header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    min-height: 36px;
    padding: 7px 9px;
    border-bottom: 1px solid var(--rule);
  }

  .files-block h3,
  .logs-block h3,
  .diff-block h3 {
    margin: 0;
    font-size: 12px;
  }

  .files-block header span,
  .logs-block header span,
  .diff-block header span {
    color: var(--muted);
    font-size: 9px;
  }

  .files-block ul {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 0 16px;
    margin: 0;
    padding: 7px 9px 9px;
    list-style: none;
  }

  .files-block li {
    display: grid;
    grid-template-columns: 14px minmax(0, 1fr);
    padding: 3px 0;
    overflow-wrap: anywhere;
    font: 10px/1.45 ui-monospace, SFMono-Regular, Consolas, monospace;
  }

  .files-block li span {
    color: var(--dispatch-dark);
  }

  .files-block > p,
  .block-state {
    margin: 0;
    padding: 14px;
    color: var(--muted);
    font-size: 11px;
  }

  .evidence-grid {
    display: grid;
    grid-template-columns: minmax(240px, .72fr) minmax(0, 1.28fr);
    gap: 12px;
    margin-top: 12px;
  }

  .logs-block ol {
    max-height: 280px;
    margin: 0;
    padding: 7px 9px 10px;
    overflow: auto;
    list-style: none;
  }

  .logs-block li {
    display: grid;
    grid-template-columns: 22px minmax(0, 1fr);
    gap: 6px;
    padding: 4px 0;
    color: #454640;
    font-size: 11px;
  }

  .logs-block li span {
    color: var(--dispatch-dark);
    font-size: 9px;
  }

  .diff-block {
    min-width: 0;
    background: var(--graphite);
    border-color: #4b4b45;
    color: var(--strip-strong);
  }

  .diff-block > header {
    border-bottom-color: #4b4b45;
  }

  .diff-block header span {
    color: #bdb9b0;
  }

  .diff-head-tools {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .diff-toggle {
    min-height: 30px;
    padding: 4px 8px;
    border: 1px solid #77786f;
    border-radius: 3px;
    background: var(--graphite-2);
    color: var(--strip-strong);
    cursor: pointer;
    font-size: 10px;
    font-weight: 650;
  }

  .diff-toggle:hover {
    border-color: #f18755;
    color: #fff;
  }

  .diff-block pre {
    max-height: 280px;
    margin: 0;
    padding: 10px;
    overflow: auto;
    color: #f2eee4;
    font: 10px/1.55 ui-monospace, SFMono-Regular, Consolas, monospace;
    tab-size: 2;
    white-space: pre;
  }

  @keyframes viewer-load {
    0% { transform: scaleX(.08); }
    55% { transform: scaleX(.72); }
    100% { transform: scaleX(1); }
  }

  @media (max-width: 900px) {
    .viewer-header {
      padding: 0 12px;
    }

    .refresh-readout {
      display: none;
    }

    .viewer-main {
      width: min(100% - 24px, 760px);
      padding-top: 18px;
    }

    .operations-board {
      grid-template-columns: minmax(260px, 320px) minmax(0, 1fr);
    }

    .fact-strip {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }

    .fact-strip > div:nth-child(2) {
      border-right: 0;
    }

    .fact-strip > div:nth-child(-n + 2) {
      border-bottom: 1px solid var(--rule);
    }

    .evidence-grid {
      grid-template-columns: 1fr;
    }
  }

  @media (max-width: 680px) {
    body {
      font-size: 14px;
    }

    .viewer-header {
      position: static;
      min-height: 54px;
    }

    .viewer-brand {
      min-width: 0;
      border-right: 0;
    }

    .project-readout {
      display: none;
    }

    .refresh-button {
      min-height: 44px;
      margin-left: 0;
    }

    .viewer-main {
      width: calc(100% - 16px);
      padding: 15px 0 18px;
    }

    .viewer-intro {
      align-items: start;
    }

    .viewer-intro h1 {
      font-size: 25px;
    }

    .viewer-intro p {
      font-size: 14px;
    }

    .read-only-mark {
      margin-top: 3px;
    }

    .status-rail {
      grid-template-columns: repeat(4, minmax(82px, 1fr));
      overflow-x: auto;
    }

    .status-rail button {
      min-height: 44px;
    }

    .viewer-error button,
    .detail-error button,
    .detail-jump,
    .ledger-search input,
    .ledger-footer button {
      min-height: 44px;
    }

    .diff-toggle {
      min-height: 44px;
    }

    .detail-jump {
      display: inline-flex;
      align-items: center;
    }

    .operations-board {
      display: block;
      height: auto;
      min-height: 0;
      overflow: visible;
    }

    .task-ledger {
      max-height: 390px;
      border-right: 0;
      border-bottom: 1px solid #272821;
    }

    .task-list {
      max-height: 320px;
    }

    .task-detail {
      min-height: 460px;
    }

    .detail-head {
      min-height: 0;
      padding: 13px;
    }

    .detail-head h2 {
      font-size: 16px;
    }

    .detail-status {
      max-width: 84px;
      text-align: right;
    }

    .detail-scroll {
      padding: 10px;
      overflow: visible;
    }

    .files-block ul {
      grid-template-columns: 1fr;
    }

    .logs-block ol,
    .diff-block pre {
      max-height: 240px;
    }
  }

  @media (max-width: 420px) {
    .viewer-header {
      padding: 0 8px;
    }

    .viewer-brand {
      gap: 6px;
      padding-right: 6px;
    }

    .viewer-brand small {
      display: none;
    }

    .connection-readout {
      min-width: 88px;
      padding-right: 8px;
      padding-left: 8px;
    }

    .refresh-button {
      padding-right: 8px;
      padding-left: 8px;
    }
  }

  @media (max-width: 360px) {
    .status-rail {
      grid-template-columns: repeat(2, minmax(0, 1fr));
      overflow: hidden;
    }

    .status-rail button:nth-child(2) {
      border-right: 0;
    }

    .status-rail button:nth-child(-n + 2) {
      border-bottom: 1px solid #4a4b46;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .viewer-app[data-loading="true"] .viewer-header::after {
      animation: none;
    }
  }
`;
