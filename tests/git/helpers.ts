import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface FixtureRepository {
  parent: string;
  root: string;
  git(args: string[]): Promise<string>;
  write(path: string, content: string | Buffer): Promise<void>;
}

export async function createFixtureRepository(): Promise<FixtureRepository> {
  const parent = await mkdtemp(resolve(tmpdir(), "visual-repo-test-"));
  const root = resolve(parent, "repo");
  await mkdir(root);
  const git = async (args: string[]): Promise<string> => {
    const result = await execFileAsync("git", args, { cwd: root });
    return result.stdout.trim();
  };
  const write = async (path: string, content: string | Buffer): Promise<void> => {
    const absolute = resolve(root, path);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, content);
  };
  await git(["init", "-q"]);
  await git(["config", "user.name", "Visual Test"]);
  await git(["config", "user.email", "visual-test@example.invalid"]);
  await write(".gitignore", ".env\n");
  await write("tracked.txt", "base\n");
  await write("delete.txt", "keep\n");
  await git(["add", ".gitignore", "tracked.txt", "delete.txt"]);
  await git(["commit", "-qm", "fixture"]);
  return { parent, root, git, write };
}
