import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import {
  formatInitResult,
  initializeVisualDev,
  transformNextConfig,
  transformViteConfig,
} from "@visual-remote/cli/init";
import { loadVisualDevConfig } from "@visual-remote/bridge-core";

const execFileAsync = promisify(execFile);

async function createRepository(
  packageJson: object,
  viteConfig = 'import { defineConfig } from "vite";\nexport default defineConfig({ plugins: [] });\n',
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "visual-init-"));
  await execFileAsync("git", ["init", "--quiet", root]);
  await writeFile(join(root, "package.json"), JSON.stringify(packageJson), "utf8");
  await writeFile(join(root, "vite.config.ts"), viteConfig, "utf8");
  return root;
}

describe("visual init", () => {
  it("configures a pnpm Vite project without overwriting existing setup", async () => {
    const root = await createRepository(
      {
        packageManager: "pnpm@10.34.5",
        scripts: { dev: "vite" },
        devDependencies: { vite: "^8.1.5", "visual-remote": "^0.3.0" },
      },
      [
        '/// <reference types="vitest/config" />',
        'import { defineConfig } from "vite";',
        "export default defineConfig(() => ({ plugins: [] }));",
        "",
      ].join("\n"),
    );

    const first = await initializeVisualDev({ cwd: root });
    expect(first).toMatchObject({
      framework: "vite",
      created: true,
      devScript: "vite",
      packageManager: "pnpm",
      integrationChanged: true,
      packageInstalled: false,
    });
    expect(formatInitResult(first)).toContain("Start the app normally");

    const configured = await readFile(join(root, "vite.config.ts"), "utf8");
    expect(configured.startsWith('/// <reference types="vitest/config" />')).toBe(true);
    expect(configured).toContain('import { visualRemote } from "visual-remote/vite";');
    expect(configured).toContain("plugins: [visualRemote(),");

    const loaded = await loadVisualDevConfig(root, {
      requireConfig: true,
      configRoot: root,
    });
    expect(loaded.config.gateway).toEqual({ host: "127.0.0.1", port: "auto" });
    expect(loaded.config.upstream.command).toEqual([
      "corepack",
      "pnpm",
      "run",
      "dev",
      "--",
      "--host",
      "0.0.0.0",
      "--port",
      "{upstreamPort}",
    ]);

    const second = await initializeVisualDev({ cwd: root });
    expect(second).toMatchObject({
      created: false,
      integrationChanged: false,
      packageInstalled: false,
    });
    expect(await readFile(join(root, "vite.config.ts"), "utf8")).toBe(configured);
  });

  it("installs the package and writes config in the current nested project", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "visual-init-monorepo-"));
    await execFileAsync("git", ["init", "--quiet", repoRoot]);
    const appRoot = join(repoRoot, "apps", "web");
    await mkdir(appRoot, { recursive: true });
    await writeFile(
      join(appRoot, "package.json"),
      JSON.stringify({ scripts: { dev: "vite" }, devDependencies: { vite: "^8.1.5" } }),
      "utf8",
    );
    await writeFile(
      join(appRoot, "vite.config.ts"),
      'import { defineConfig } from "vite";\nexport default defineConfig({ plugins: [] });\n',
      "utf8",
    );
    const installPackage = vi.fn(async () => {});

    const result = await initializeVisualDev({ cwd: appRoot, installPackage });

    expect(result.configPath).toBe(join(appRoot, ".visualdev/config.yaml"));
    expect(result.packageInstalled).toBe(true);
    expect(installPackage).toHaveBeenCalledWith({
      cwd: appRoot,
      packageManager: "npm",
      packageSpec: "visual-remote@latest",
    });
    const loaded = await loadVisualDevConfig(repoRoot, {
      requireConfig: true,
      configRoot: appRoot,
    });
    expect(loaded.configRoot).toBe(appRoot);
    expect(loaded.workspaceRoot).toBe(appRoot);
    expect(loaded.config.project.id).toBe("web");
  });

  it("configures a Next.js project and preserves existing client instrumentation", async () => {
    const root = await createRepository({
      scripts: { dev: "next dev" },
      dependencies: { next: "^16.2.12" },
      devDependencies: { "visual-remote": "^0.3.0" },
    });
    await writeFile(
      join(root, "next.config.mjs"),
      "const nextConfig = { reactStrictMode: true };\nexport default nextConfig;\n",
      "utf8",
    );
    await writeFile(
      join(root, "instrumentation-client.js"),
      'console.log("existing instrumentation");\n',
      "utf8",
    );

    const first = await initializeVisualDev({ cwd: root });
    expect(first).toMatchObject({
      framework: "next",
      integrationChanged: true,
      clientChanged: true,
      packageInstalled: false,
    });
    expect(await readFile(join(root, "next.config.mjs"), "utf8")).toContain(
      'export default withVisualRemote(nextConfig);',
    );
    const client = await readFile(join(root, "instrumentation-client.js"), "utf8");
    expect(client).toContain("existing instrumentation");
    expect(client).toContain('import("visual-remote/next/client")');

    const second = await initializeVisualDev({ cwd: root });
    expect(second).toMatchObject({
      framework: "next",
      integrationChanged: false,
      clientChanged: false,
    });
    expect(await readFile(join(root, "instrumentation-client.js"), "utf8")).toBe(client);
  });

  it("creates missing Next.js integration files", async () => {
    const root = await createRepository({
      scripts: { dev: "next dev" },
      dependencies: { next: "^16.2.12" },
    });
    await writeFile(join(root, "tsconfig.json"), "{}", "utf8");
    const installPackage = vi.fn(async () => {});

    const result = await initializeVisualDev({ cwd: root, installPackage });

    expect(result).toMatchObject({
      framework: "next",
      integrationPath: join(root, "next.config.mjs"),
      clientPath: join(root, "instrumentation-client.ts"),
      packageInstalled: true,
    });
    expect(await readFile(join(root, "next.config.mjs"), "utf8")).toContain(
      "withVisualRemote({})",
    );
    expect(await readFile(join(root, "instrumentation-client.ts"), "utf8")).toContain(
      "visual-remote/next/client",
    );
  });

  it("rejects unsupported projects before installing anything", async () => {
    const root = await createRepository({
      scripts: { dev: "react-scripts start" },
      dependencies: { "react-scripts": "^5.0.1" },
    });
    const installPackage = vi.fn(async () => {});

    await expect(initializeVisualDev({ cwd: root, installPackage })).rejects.toThrow(
      "visual init currently supports Vite and Next.js projects",
    );
    expect(installPackage).not.toHaveBeenCalled();
  });

  it("adds a plugins array to an object Vite config", () => {
    const transformed = transformViteConfig(
      'import { defineConfig } from "vite";\nexport default defineConfig({ server: {} });\n',
    );
    expect(transformed).toContain("plugins: [visualRemote()]");
  });

  it("wraps CommonJS and direct-object Next.js configs", () => {
    const commonJs = transformNextConfig(
      "const nextConfig = { reactStrictMode: true };\nmodule.exports = nextConfig\n",
    );
    expect(commonJs).toContain('require("visual-remote/next")');
    expect(commonJs).toContain("module.exports = withVisualRemote(nextConfig)");

    const esm = transformNextConfig("export default { reactStrictMode: true };\n");
    expect(esm).toContain("export default withVisualRemote({ reactStrictMode: true });");
  });
});
