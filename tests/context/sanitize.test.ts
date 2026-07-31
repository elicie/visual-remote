import { describe, expect, it } from "vitest";

import type { ContextBundle } from "@visual-remote/protocol";
import {
  redactSecrets,
  redactSecretValues,
  sanitizeContextBundle,
} from "@visual-remote/bridge-core";

describe("sanitizeContextBundle", () => {
  it("drops sensitive attributes and redacts token-like values", () => {
    const bundle = {
      version: 1,
      projectId: "demo",
      browserSessionId: "9e9d8c91-da84-4857-8903-8ef02a0dd7a4",
      page: {
        url: "http://dev:10001/",
        pathname: "/",
        title: "Demo",
        viewport: { width: 1280, height: 720 },
        devicePixelRatio: 1,
        scroll: { x: 0, y: 0 },
        renderRevision: 1,
      },
      selection: {
        mode: "element",
        targets: [
          {
            targetId: "one",
            order: 0,
            dom: {
              tagName: "button",
              classNames: ["button"],
              text: "Bearer super-secret-value",
              attributes: {
                value: "private",
                "data-token": "secret",
                "aria-label": "Save",
              },
              rect: { x: 0, y: 0, width: 80, height: 32 },
              locatorCandidates: [],
              parentPath: [],
            },
            styles: {},
            source: { stack: [], confidence: "unknown" },
          },
        ],
      },
      request: { text: "Make it smaller", scope: "instance" },
    } satisfies ContextBundle;

    const sanitized = sanitizeContextBundle(bundle);
    const target = sanitized.selection.targets[0]!;

    expect(target.dom.attributes).toEqual({ "aria-label": "Save" });
    expect(target.dom.text).toBe("[REDACTED]");
  });

  it("redacts credential values recursively without masking ordinary token prose", () => {
    const sanitized = redactSecretValues({
      token: "pairing-secret",
      nested: {
        authorization: "Bearer auth-secret",
        summary:
          "Authorization: Bearer header-secret Cookie: session=cookie-secret",
        command: "OPENAI_API_KEY=sk-abcdefghijklmnop npm test",
      },
    });

    expect(JSON.stringify(sanitized)).not.toMatch(
      /pairing-secret|auth-secret|header-secret|cookie-secret|abcdefghijklmnop/u,
    );
    expect(sanitized).toMatchObject({
      token: "[REDACTED]",
      nested: {
        authorization: "[REDACTED]",
        command: "OPENAI_API_KEY=[REDACTED] npm test",
      },
    });
    expect(redactSecrets("token count=42; tokenizer ready")).toBe(
      "token count=42; tokenizer ready",
    );
  });
});
