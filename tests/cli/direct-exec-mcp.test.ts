import { describe, expect, it } from "vitest";

import {
  directExecToolResult,
  parseArguments,
  parseBatchRequest,
} from "../../apps/cli/src/direct-exec-mcp.js";

describe("direct-exec MCP server", () => {
  it("parses the registered roots and keeps RTK preference server-controlled", () => {
    expect(
      parseArguments([
        "--repo-root",
        "/repo",
        "--workspace-root",
        "/repo/apps/web",
        "--rtk",
        "/bin/rtk",
      ]),
    ).toEqual({
      repoRoot: "/repo",
      workspaceRoot: "/repo/apps/web",
      rtkExecutable: "/bin/rtk",
    });
    expect(
      parseBatchRequest({
        commands: [{ argv: ["git", "status", "--short"] }],
        preferRtk: false,
      }),
    ).toMatchObject({ preferRtk: true });
  });

  it("keeps command output in MCP text without duplicating it in structured metadata", () => {
    const response = directExecToolResult({
      stoppedEarly: false,
      results: [
        {
          argv: ["rtk", "git", "status", "--short"],
          cwd: "/repo",
          durationMs: 4,
          exitCode: 0,
          stdout: "M src/app.ts",
          stderr: "",
          timedOut: false,
          truncated: false,
          usedRtk: true,
        },
      ],
    }) as {
      content: Array<{ text: string }>;
      structuredContent: { results: Array<Record<string, unknown>> };
    };

    expect(response.content[0]?.text).toContain("M src/app.ts");
    expect(response.structuredContent.results[0]).toMatchObject({
      argv: ["rtk", "git", "status", "--short"],
      durationMs: 4,
      usedRtk: true,
    });
    expect(response.structuredContent.results[0]).not.toHaveProperty("stdout");
    expect(response.structuredContent.results[0]).not.toHaveProperty("stderr");
  });
});
