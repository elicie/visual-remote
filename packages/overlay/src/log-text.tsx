import { useId, useState } from "preact/hooks";

import { compactText } from "./helpers.js";

/** Keep previews at the presentation boundary; text is always the retained output. */
export function LogText({ text, compact = false }: { text: string; compact?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const contentId = useId();
  const preview = compact
    ? compactText(text, 500)
    : text.slice(0, 600).split("\n").slice(0, 6).join("\n");
  const expandable = preview !== text;
  if (!expandable) return <pre class="log-text">{text}</pre>;
  return (
    <div class="log-entry">
      <button
        type="button"
        class="log-toggle"
        aria-label={expanded ? "로그 접기" : "전체 로그 펼치기"}
        aria-expanded={expanded ? "true" : "false"}
        aria-controls={contentId}
        onClick={() => setExpanded(!expanded)}
      >
        {!expanded ? <span class="log-text">{compact ? preview : `${preview}\n…`}</span> : null}
        <span class="log-toggle-label">{expanded ? "로그 접기" : "전체 로그 펼치기"}</span>
      </button>
      <pre id={contentId} class="log-text" hidden={!expanded}>{text}</pre>
    </div>
  );
}

export const logTextStyles = String.raw`
  .log-entry { min-width: 0; }
  .log-text { display: block; margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; font: 11px/1.55 ui-monospace, SFMono-Regular, Consolas, monospace; }
  .log-text[hidden] { display: none; }
  .log-toggle { display: block; width: 100%; min-height: 30px; padding: 4px 6px; border: 1px solid var(--rule); border-radius: 3px; background: var(--strip-strong); color: inherit; text-align: left; cursor: pointer; }
  .log-toggle-label { display: block; margin-top: 4px; font-size: 11px; text-decoration: underline; text-underline-offset: 2px; }
  .log-toggle:hover { background: var(--strip); }
  .log-toggle:focus-visible { outline: 3px solid var(--strip-strong); outline-offset: 2px; box-shadow: 0 0 0 5px var(--dispatch-dark); }
  .log-toggle[aria-expanded="true"] { margin-bottom: 5px; }
`;
