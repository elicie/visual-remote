import packageMetadata from "../../package.json" with { type: "json" };

import { createCli, VISUAL_REMOTE_VERSION } from "@visual-remote/cli";
import { describe, expect, it } from "vitest";

describe("CLI version", () => {
  it("matches the published package version", () => {
    expect(VISUAL_REMOTE_VERSION).toBe(packageMetadata.version);
    expect(createCli().version()).toBe(packageMetadata.version);
  });
});
