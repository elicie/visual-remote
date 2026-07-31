import { mkdtemp, mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

import { normalizeSourceLocation } from "@visual-remote/bridge-core";

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "visual-source-"));
  spawnSync("git", ["init", "-q"], { cwd: root });
  await mkdir(join(root, "src", "components"), { recursive: true });
  await writeFile(
    join(root, "src", "components", "Button.tsx"),
    "export function Button() {\n  return <button />;\n}\n",
  );
  spawnSync("git", ["add", "."], { cwd: root });
  return await realpath(root);
}

describe("normalizeSourceLocation", () => {
  it("resolves a bundler path to a repository file", async () => {
    const root = await fixture();
    const result = await normalizeSourceLocation(
      {
        filePath: "webpack://_N_E/./src/components/Button.tsx?abc",
        lineNumber: 2,
      },
      root,
    );

    expect(result.confidence).toBe("exact");
    expect(result.filePath).toBe("src/components/Button.tsx");
    expect(result.lineNumber).toBe(2);
  });

  it("preserves the source directory in a Vite URL", async () => {
    const root = await fixture();
    const result = await normalizeSourceLocation(
      { filePath: "vite://src/components/Button.tsx" },
      root,
    );

    expect(result.confidence).toBe("exact");
    expect(result.filePath).toBe("src/components/Button.tsx");
  });

  it("rejects an absolute path outside the repository", async () => {
    const root = await fixture();
    const result = await normalizeSourceLocation({ filePath: "/etc/passwd" }, root);

    expect(result.confidence).toBe("unknown");
    expect(result.absolutePath).toBeUndefined();
  });

  it("rejects a symlink that escapes the repository", async () => {
    const root = await fixture();
    await symlink("/etc/passwd", join(root, "src", "outside"));
    const result = await normalizeSourceLocation({ filePath: "src/outside" }, root);

    expect(result.confidence).toBe("unknown");
  });
});
