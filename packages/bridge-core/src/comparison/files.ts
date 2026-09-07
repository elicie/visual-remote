import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, realpath } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { MAX_PNG_BYTES, decodePng } from "./metrics.js";
import type { ControlArtifact } from "../bridge/control-service.js";
const safeTask = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const safeArtifact =
  /^(?:reference|(?:capture|heatmap|overlay)-[1-9][0-9]?)\.png$/u;
export async function taskDirectory(
  root: string,
  taskId: string,
  create = false,
): Promise<string> {
  if (!isAbsolute(root) || !safeTask.test(taskId))
    throw new Error("Invalid private comparison directory or task ID");
  if (create) await mkdir(root, { recursive: true, mode: 0o700 });
  const canonical = await realpath(root);
  if (!(await lstat(canonical)).isDirectory())
    throw new Error("Comparison root must resolve to a directory");
  const directory = join(canonical, taskId);
  if (create) {
    await chmod(canonical, 0o700);
    await mkdir(directory, { mode: 0o700 });
  }
  if (
    (await realpath(directory)) !== directory ||
    !(await lstat(directory)).isDirectory()
  )
    throw new Error("Comparison task directory may not be a symlink");
  return directory;
}
export async function readPrivate(
  directory: string,
  name: string,
  max = MAX_PNG_BYTES,
): Promise<Buffer> {
  if ((await realpath(directory)) !== directory)
    throw new Error("Comparison directory changed");
  const handle = await open(
    join(directory, name),
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const stat = await handle.stat();
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.size > max ||
      stat.size === 0
    )
      throw new Error("Invalid or oversized comparison file");
    const buffer = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        offset,
        buffer.length - offset,
        offset,
      );
      if (!bytesRead) throw new Error("Comparison file changed while reading");
      offset += bytesRead;
    }
    if ((await handle.stat()).size !== stat.size)
      throw new Error("Comparison file changed while reading");
    await handle.chmod(0o600);
    return buffer;
  } finally {
    await handle.close();
  }
}
export async function writePrivate(
  directory: string,
  name: string,
  content: Buffer | string,
): Promise<void> {
  if ((await realpath(directory)) !== directory)
    throw new Error("Comparison directory changed");
  const handle = await open(
    join(directory, name),
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(content);
  } finally {
    await handle.close();
  }
}
export async function getComparisonArtifact(
  root: string,
  artifactId: string,
): Promise<ControlArtifact | undefined> {
  const parts = artifactId.split("/");
  if (
    parts.length !== 2 ||
    !safeTask.test(parts[0]!) ||
    !safeArtifact.test(parts[1]!)
  )
    return undefined;
  try {
    const directory = await taskDirectory(root, parts[0]!);
    const registry: unknown = JSON.parse(
      (await readPrivate(directory, "artifacts.json", 32768)).toString("utf8"),
    );
    if (!Array.isArray(registry) || !registry.includes(parts[1]!))
      return undefined;
    const body = await readPrivate(directory, parts[1]!);
    decodePng(body);
    return { body, contentType: "image/png", fileName: parts[1]! };
  } catch {
    return undefined;
  }
}
export async function updateRegistry(
  directory: string,
  names: string[],
): Promise<void> {
  const handle = await open(
    join(directory, "artifacts.json"),
    constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1)
      throw new Error("Invalid artifact registry");
    await handle.truncate(0);
    await handle.writeFile(JSON.stringify(names));
    await handle.chmod(0o600);
  } finally {
    await handle.close();
  }
}
