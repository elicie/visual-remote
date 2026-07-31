import { createServer } from "node:net";

export const MIN_SERVICE_PORT = 10_001;
export const MAX_SERVICE_PORT = 65_535;

export function assertServicePort(port: number): void {
  if (!Number.isInteger(port) || port < MIN_SERVICE_PORT || port > MAX_SERVICE_PORT) {
    throw new RangeError(
      `Port must be an integer between ${MIN_SERVICE_PORT} and ${MAX_SERVICE_PORT}`,
    );
  }
}

export async function isPortAvailable(port: number, host = "0.0.0.0"): Promise<boolean> {
  assertServicePort(port);

  return await new Promise<boolean>((resolve, reject) => {
    const probe = createServer();
    probe.unref();
    probe.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE" || error.code === "EACCES") {
        resolve(false);
        return;
      }
      reject(error);
    });
    probe.listen({ host, port, exclusive: true }, () => {
      probe.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(true);
      });
    });
  });
}

export async function findAvailablePort(
  startPort = MIN_SERVICE_PORT,
  host = "0.0.0.0",
  excludedPorts: ReadonlySet<number> = new Set(),
): Promise<number> {
  assertServicePort(startPort);

  for (let port = startPort; port <= MAX_SERVICE_PORT; port += 1) {
    if (!excludedPorts.has(port) && (await isPortAvailable(port, host))) {
      return port;
    }
  }

  throw new Error(`No available port found at or above ${startPort}`);
}
