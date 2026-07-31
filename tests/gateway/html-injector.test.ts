import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  HtmlInjectionTransform,
  injectOverlayIntoHtml,
  OVERLAY_SCRIPT_TAG,
} from "@visual-remote/gateway";

async function transformChunks(chunks: readonly string[]): Promise<string> {
  const transform = new HtmlInjectionTransform({ initialBufferBytes: 16 });
  const output: Buffer[] = [];
  transform.on("data", (chunk: Buffer) => output.push(chunk));
  await new Promise<void>((resolve, reject) => {
    Readable.from(chunks).pipe(transform).once("finish", resolve).once("error", reject);
  });
  return Buffer.concat(output).toString("utf8");
}

async function transformBuffers(chunks: readonly Buffer[]): Promise<string> {
  const transform = new HtmlInjectionTransform();
  const output: Buffer[] = [];
  transform.on("data", (chunk: Buffer) => output.push(chunk));
  await new Promise<void>((resolve, reject) => {
    Readable.from(chunks).pipe(transform).once("finish", resolve).once("error", reject);
  });
  return Buffer.concat(output).toString("utf8");
}

describe("HTML overlay injection", () => {
  it("injects immediately after an opening head tag", () => {
    expect(injectOverlayIntoHtml("<html><head data-x='1'><title>x</title></head></html>")).toBe(
      `<html><head data-x='1'>${OVERLAY_SCRIPT_TAG}<title>x</title></head></html>`,
    );
  });

  it("falls back to before body close across stream chunk boundaries", async () => {
    const result = await transformChunks([
      "<!doctype html><html><main>content that exceeds the initial buffer",
      "</bo",
      "dy></html>",
    ]);

    expect(result).toContain(`buffer${OVERLAY_SCRIPT_TAG}</body>`);
    expect(result.match(/\/_visual\/client\.js/g)).toHaveLength(1);
  });

  it("does not inject a duplicate overlay bundle", async () => {
    const html = `<html><head>${OVERLAY_SCRIPT_TAG}</head><body></body></html>`;
    expect(await transformChunks([html])).toBe(html);
  });

  it("appends the script when neither head nor body exists", async () => {
    expect(await transformChunks(["<main>Hello</main>"])).toBe(
      `<main>Hello</main>${OVERLAY_SCRIPT_TAG}`,
    );
  });

  it("handles the Buffer chunks emitted by HTTP responses", async () => {
    expect(
      await transformBuffers([
        Buffer.from("<html><he"),
        Buffer.from("ad></head><body>buffer</body></html>"),
      ]),
    ).toContain(`<head>${OVERLAY_SCRIPT_TAG}</head>`);
  });

  it("preserves UTF-8 characters split across Buffer chunks", async () => {
    const html = Buffer.from("<html><head></head><body>한글</body></html>");
    const splitAt = html.indexOf(Buffer.from("한")) + 1;
    const result = await transformBuffers([
      html.subarray(0, splitAt),
      html.subarray(splitAt),
    ]);
    expect(result).toContain("<body>한글</body>");
  });
});
