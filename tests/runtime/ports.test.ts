import { createServer } from "node:net";
import { describe, expect, it } from "vitest";
import { findAvailablePort } from "@visual-remote/bridge-core";

describe("service port selection", () => {
  it("moves to the next available port when the first candidate is occupied", async () => {
    const occupiedPort = await findAvailablePort(10_001, "127.0.0.1");
    const occupied = createServer();
    await new Promise<void>((resolve, reject) => {
      occupied.once("error", reject);
      occupied.listen(occupiedPort, "127.0.0.1", resolve);
    });

    try {
      expect(await findAvailablePort(10_001, "127.0.0.1")).toBeGreaterThan(
        occupiedPort,
      );
    } finally {
      await new Promise<void>((resolve, reject) => {
        occupied.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});
