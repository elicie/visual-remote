import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  loadVisualDevConfig,
  mergeConfigValues,
  VisualDevConfigError,
} from "@visual-remote/bridge-core";

describe("visual dev config", () => {
  it("deep-merges local mappings while replacing arrays", async () => {
    const root = await mkdtemp(join(tmpdir(), "visual-config-"));
    await mkdir(join(root, ".visualdev"));
    await writeFile(
      join(root, ".visualdev/config.yaml"),
      [
        "version: 1",
        "project:",
        "  id: fixture",
        "gateway:",
        "  port: 10011",
        "security:",
        "  allowedOrigins:",
        "    - https://base.example",
        "verification:",
        "  commands:",
        "    - name: base",
        "      command: [npm, test]",
        "",
      ].join("\n"),
    );
    await writeFile(
      join(root, ".visualdev/config.local.yaml"),
      [
        "gateway:",
        "  host: 127.0.0.1",
        "security:",
        "  allowedOrigins:",
        "    - https://local.example",
        "verification:",
        "  commands:",
        "    - name: local",
        "      command: [npm, run, typecheck]",
        "",
      ].join("\n"),
    );

    const loaded = await loadVisualDevConfig(root);

    expect(loaded.config.gateway).toEqual({
      host: "127.0.0.1",
      port: 10011,
    });
    expect(loaded.config.security.allowedOrigins).toEqual(["https://local.example"]);
    expect(loaded.config.verification.commands).toEqual([
      {
        name: "local",
        command: ["npm", "run", "typecheck"],
        timeoutMs: 120_000,
      },
    ]);
    expect(loaded.config.agent.adapter).toBe("codex");
    expect(loaded.loadedFiles).toEqual([
      join(root, ".visualdev/config.yaml"),
      join(root, ".visualdev/config.local.yaml"),
    ]);
  });

  it("uses safe service defaults when attach mode has no config", async () => {
    const root = await mkdtemp(join(tmpdir(), "visual-config-default-"));
    const loaded = await loadVisualDevConfig(root);

    expect(loaded.config.project.id).toBe(root.split("/").at(-1));
    expect(loaded.config.gateway).toEqual({
      host: "0.0.0.0",
      port: 10_001,
    });
    expect(loaded.config.upstream.port).toBe("auto");
    expect(loaded.loadedFiles).toEqual([]);
  });

  it("rejects a workspace symlink that escapes the worktree", async () => {
    const root = await mkdtemp(join(tmpdir(), "visual-config-root-"));
    const outside = await mkdtemp(join(tmpdir(), "visual-config-outside-"));
    await mkdir(join(root, ".visualdev"));
    await symlink(outside, join(root, "outside"));
    await writeFile(
      join(root, ".visualdev/config.yaml"),
      [
        "version: 1",
        "project:",
        "  id: fixture",
        "  workspace: outside",
        "",
      ].join("\n"),
    );

    await expect(loadVisualDevConfig(root)).rejects.toThrow(VisualDevConfigError);
  });

  it("merges only mappings recursively", () => {
    expect(
      mergeConfigValues(
        { nested: { kept: true, values: ["base"] }, scalar: 1 },
        { nested: { values: ["local"] }, scalar: 2 },
      ),
    ).toEqual({
      nested: { kept: true, values: ["local"] },
      scalar: 2,
    });
  });
});
