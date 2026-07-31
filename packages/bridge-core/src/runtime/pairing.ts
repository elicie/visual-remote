import { randomBytes, timingSafeEqual } from "node:crypto";

export function generatePairingToken(): string {
  return randomBytes(32).toString("base64url");
}

export function pairingTokensMatch(expected: string, candidate: string): boolean {
  const expectedBytes = Buffer.from(expected);
  const candidateBytes = Buffer.from(candidate);
  return (
    expectedBytes.length === candidateBytes.length &&
    timingSafeEqual(expectedBytes, candidateBytes)
  );
}

export function createPairingUrl(baseUrl: string, token: string): string {
  const url = new URL(baseUrl);
  url.hash = `visual-pair=${encodeURIComponent(token)}`;
  return url.toString();
}
