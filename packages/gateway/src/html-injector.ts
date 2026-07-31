import { Transform, type TransformCallback } from "node:stream";
import { StringDecoder } from "node:string_decoder";

export const OVERLAY_SCRIPT_TAG =
  '<script type="module" src="/_visual/client.js"></script>';

const OVERLAY_PATH_PATTERN = /<script\b[^>]*\bsrc=["']\/_visual\/client\.js["'][^>]*>/i;
const HEAD_PATTERN = /<head\b[^>]*>/i;
const BODY_END_PATTERN = /<\/body\s*>/i;

export function injectOverlayIntoHtml(
  html: string,
  scriptTag = OVERLAY_SCRIPT_TAG,
): string {
  if (OVERLAY_PATH_PATTERN.test(html)) {
    return html;
  }

  const head = HEAD_PATTERN.exec(html);
  if (head?.index !== undefined) {
    const insertionPoint = head.index + head[0].length;
    return `${html.slice(0, insertionPoint)}${scriptTag}${html.slice(insertionPoint)}`;
  }

  const bodyEnd = BODY_END_PATTERN.exec(html);
  if (bodyEnd?.index !== undefined) {
    return `${html.slice(0, bodyEnd.index)}${scriptTag}${html.slice(bodyEnd.index)}`;
  }

  return `${html}${scriptTag}`;
}

export interface HtmlInjectionTransformOptions {
  scriptTag?: string;
  initialBufferBytes?: number;
}

/**
 * Buffers only the start of a response while looking for <head>. If it is absent,
 * the transform keeps a short trailing window so </body> can still be detected
 * across chunk boundaries without buffering the entire document.
 */
export class HtmlInjectionTransform extends Transform {
  readonly #scriptTag: string;
  readonly #initialBufferBytes: number;
  readonly #decoder = new StringDecoder("utf8");
  #buffer = "";
  #phase: "initial" | "body-search" | "passthrough" = "initial";
  #injected = false;

  constructor(options: HtmlInjectionTransformOptions = {}) {
    super({ decodeStrings: false });
    this.#scriptTag = options.scriptTag ?? OVERLAY_SCRIPT_TAG;
    this.#initialBufferBytes = options.initialBufferBytes ?? 64 * 1024;
  }

  override _transform(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: TransformCallback,
  ): void {
    try {
      const text = typeof chunk === "string" ? chunk : this.#decoder.write(chunk);
      if (this.#phase === "passthrough") {
        this.push(text);
        callback();
        return;
      }

      this.#buffer += text;
      if (this.#phase === "initial") {
        if (OVERLAY_PATH_PATTERN.test(this.#buffer)) {
          this.#injected = true;
          this.#phase = "passthrough";
          this.push(this.#buffer);
          this.#buffer = "";
          callback();
          return;
        }

        const head = HEAD_PATTERN.exec(this.#buffer);
        if (head?.index !== undefined) {
          const insertionPoint = head.index + head[0].length;
          this.push(
            `${this.#buffer.slice(0, insertionPoint)}${this.#scriptTag}${this.#buffer.slice(insertionPoint)}`,
          );
          this.#buffer = "";
          this.#injected = true;
          this.#phase = "passthrough";
          callback();
          return;
        }

        const bodyEnd = BODY_END_PATTERN.exec(this.#buffer);
        if (bodyEnd?.index !== undefined) {
          this.push(
            `${this.#buffer.slice(0, bodyEnd.index)}${this.#scriptTag}${this.#buffer.slice(bodyEnd.index)}`,
          );
          this.#buffer = "";
          this.#injected = true;
          this.#phase = "passthrough";
          callback();
          return;
        }

        if (Buffer.byteLength(this.#buffer) >= this.#initialBufferBytes) {
          this.#phase = "body-search";
          this.#flushSearchWindow();
        }
        callback();
        return;
      }

      const bodyEnd = BODY_END_PATTERN.exec(this.#buffer);
      if (bodyEnd?.index !== undefined) {
        this.push(
          `${this.#buffer.slice(0, bodyEnd.index)}${this.#scriptTag}${this.#buffer.slice(bodyEnd.index)}`,
        );
        this.#buffer = "";
        this.#injected = true;
        this.#phase = "passthrough";
      } else {
        this.#flushSearchWindow();
      }
      callback();
    } catch (error) {
      callback(error instanceof Error ? error : new Error(String(error)));
    }
  }

  override _flush(callback: TransformCallback): void {
    try {
      this.#buffer += this.#decoder.end();
      if (this.#injected || OVERLAY_PATH_PATTERN.test(this.#buffer)) {
        this.push(this.#buffer);
      } else {
        this.push(injectOverlayIntoHtml(this.#buffer, this.#scriptTag));
      }
      this.#buffer = "";
      callback();
    } catch (error) {
      callback(error instanceof Error ? error : new Error(String(error)));
    }
  }

  #flushSearchWindow(): void {
    const retainedCharacters = 32;
    if (this.#buffer.length <= retainedCharacters) {
      return;
    }
    const flushThrough = this.#buffer.length - retainedCharacters;
    this.push(this.#buffer.slice(0, flushThrough));
    this.#buffer = this.#buffer.slice(flushThrough);
  }
}
