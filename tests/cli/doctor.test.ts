import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { runDoctor } from "@visual-remote/cli/doctor";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

async function createRepository(): Promise<string> {
  const repoRoot = await mkdtemp(join(tmpdir(), "visual-doctor-repo-"));
  await execFileAsync("git", ["init", "--quiet", repoRoot]);
  return repoRoot;
}

async function addExecutable(directory: string, name: string): Promise<void> {
  await writeFile(join(directory, name), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
}

describe("visual doctor", () => {
  it("checks the configured agent, RTK, verification, and remote access setup", async () => {
    const repoRoot = await createRepository();
    const binDirectory = await mkdtemp(join(tmpdir(), "visual-doctor-bin-"));
    await Promise.all(
      ["codex", "rtk", "fake-dev", "fake-check"].map((name) =>
        addExecutable(binDirectory, name),
      ),
    );
    await mkdir(join(repoRoot, ".visualdev"));
    await writeFile(
      join(repoRoot, ".visualdev/config.yaml"),
      [
        "version: 1",
        "project:",
        "  id: doctor-fixture",
        "gateway:",
        "  publicUrl: https://canvas.example.test",
        "upstream:",
        "  command: [fake-dev]",
        "verification:",
        "  commands:",
        "    - name: smoke",
        "      command: [fake-check]",
        "security:",
        "  allowedOrigins:",
        "    - https://canvas.example.test",
        "",
      ].join("\n"),
    );

    const checks = await runDoctor({
      cwd: repoRoot,
      environment: { ...process.env, PATH: binDirectory },
    });
    const statuses = Object.fromEntries(
      checks.map(({ name, status }) => [name, status]),
    );

    expect(statuses).toMatchObject({
      config: "pass",
      "dev-command": "pass",
      agent: "pass",
      rtk: "pass",
      verification: "pass",
      "public-url": "pass",
      "allowed-origins": "pass",
    });
  });

  it("warns about optional defaults and fails when Codex is unavailable", async () => {
    const repoRoot = await createRepository();
    const emptyPath = await mkdtemp(join(tmpdir(), "visual-doctor-empty-bin-"));

    const checks = await runDoctor({
      cwd: repoRoot,
      environment: { ...process.env, PATH: emptyPath },
    });
    const statuses = Object.fromEntries(
      checks.map(({ name, status }) => [name, status]),
    );

    expect(statuses).toMatchObject({
      config: "warning",
      agent: "fail",
      rtk: "warning",
      verification: "warning",
      "public-url": "warning",
      "allowed-origins": "warning",
    });
  });

  it("accepts an installed Claude adapter", async () => {
    const repoRoot = await createRepository();
    const binDirectory = await mkdtemp(join(tmpdir(), "visual-doctor-claude-bin-"));
    await addExecutable(binDirectory, "claude");
    await mkdir(join(repoRoot, ".visualdev"));
    await writeFile(
      join(repoRoot, ".visualdev/config.yaml"),
      [
        "version: 1",
        "project:",
        "  id: doctor-claude-fixture",
        "agent:",
        "  adapter: claude",
        "  inheritEnv: [ANTHROPIC_API_KEY]",
        "",
      ].join("\n"),
    );

    const checks = await runDoctor({
      cwd: repoRoot,
      environment: {
        ...process.env,
        PATH: binDirectory,
        ANTHROPIC_API_KEY: "test-key",
      },
    });
    expect(checks.find(({ name }) => name === "agent")).toMatchObject({
      status: "pass",
      message: "claude is executable.",
    });
    expect(checks.find(({ name }) => name === "agent-environment")).toMatchObject({
      status: "pass",
    });
    expect(checks.find(({ name }) => name === "claude-sandbox")).toMatchObject({
      status: "warning",
    });
  });
});
