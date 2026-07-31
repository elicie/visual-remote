import type { ContextBundle, TargetContext } from "@visual-remote/protocol";

const blockedAttribute = /^(?:value|password|authorization|cookie|srcdoc)$/iu;
const sensitiveDataAttribute = /^data-(?:token|secret|key|auth|session|cookie)/iu;
const sensitiveKeyPattern =
  /^(?:authorization|proxy-authorization|cookie|set-cookie|token|pairing[ _-]?token|visual[ _-]?pair|api[ _-]?key|openai[ _-]?api[ _-]?key)$/iu;
const cookieHeaderPattern = /\b(?:set-cookie|cookie)\s*:\s*[^\r\n]*/giu;
const authorizationPattern =
  /(\b(?:proxy-)?authorization\b\s*[:=]\s*)(?:bearer\s+)?[A-Za-z0-9._~+/=-]+/giu;
const bearerPattern = /\bBearer[ \t]+[A-Za-z0-9._~+/=-]{8,}/giu;
const secretAssignmentPattern =
  /(\b(?:pairing[ _-]?token|visual[ _-]?pair|openai[ _-]?api[ _-]?key|api[ _-]?key)\b\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}\]]+)/giu;
const jsonSecretPattern =
  /("(?:authorization|proxy-authorization|cookie|set-cookie|token|pairing[ _-]?token|visual[ _-]?pair|openai[ _-]?api[ _-]?key|api[ _-]?key)"\s*:\s*)"(?:\\.|[^"\\])*"/giu;
const openAiKeyPattern = /\bsk-[A-Za-z0-9_-]{12,}\b/gu;

export interface ContextLimits {
  maxTextLength: number;
  maxClassNames: number;
  maxAttributes: number;
  maxStyleProperties: number;
  maxStackFrames: number;
}

export const defaultContextLimits: ContextLimits = {
  maxTextLength: 500,
  maxClassNames: 100,
  maxAttributes: 40,
  maxStyleProperties: 40,
  maxStackFrames: 8,
};

export function redactSecrets(value: string): string {
  return value
    .replace(cookieHeaderPattern, (match) => `${match.split(":")[0]}: [REDACTED]`)
    .replace(authorizationPattern, "$1[REDACTED]")
    .replace(bearerPattern, "[REDACTED]")
    .replace(secretAssignmentPattern, "$1[REDACTED]")
    .replace(jsonSecretPattern, '$1"[REDACTED]"')
    .replace(openAiKeyPattern, "[REDACTED]");
}

export function redactSecretValues<T>(value: T): T {
  if (typeof value === "string") {
    return redactSecrets(value) as T;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactSecretValues(entry)) as T;
  }
  if (
    typeof value !== "object"
    || value === null
    || (Object.getPrototypeOf(value) !== Object.prototype
      && Object.getPrototypeOf(value) !== null)
  ) {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      sensitiveKeyPattern.test(key) && typeof entry === "string"
        ? "[REDACTED]"
        : redactSecretValues(entry),
    ]),
  ) as T;
}

export function redactText(value: string, maxLength = 500): string {
  return redactSecrets(value).slice(0, maxLength);
}

function sanitizeTarget(target: TargetContext, limits: ContextLimits): TargetContext {
  const attributes = Object.fromEntries(
    Object.entries(target.dom.attributes)
      .filter(([key]) => !blockedAttribute.test(key) && !sensitiveDataAttribute.test(key))
      .slice(0, limits.maxAttributes)
      .map(([key, value]) => [key, redactText(value, limits.maxTextLength)]),
  );
  const styles = Object.fromEntries(
    Object.entries(target.styles).slice(0, limits.maxStyleProperties),
  );

  return {
    ...target,
    dom: {
      ...target.dom,
      classNames: target.dom.classNames.slice(0, limits.maxClassNames),
      ...(target.dom.text === undefined
        ? {}
        : { text: redactText(target.dom.text, limits.maxTextLength) }),
      ...(target.dom.accessibleName === undefined
        ? {}
        : {
            accessibleName: redactText(
              target.dom.accessibleName,
              limits.maxTextLength,
            ),
          }),
      attributes,
      parentPath: target.dom.parentPath.slice(-8),
    },
    styles,
    source: {
      ...target.source,
      stack: target.source.stack.slice(0, limits.maxStackFrames),
    },
  };
}

export function sanitizeContextBundle(
  bundle: ContextBundle,
  limits: ContextLimits = defaultContextLimits,
): ContextBundle {
  const targets = bundle.selection.targets.map((target) => sanitizeTarget(target, limits));
  return {
    ...bundle,
    selection: {
      ...bundle.selection,
      targets,
    } as ContextBundle["selection"],
    request: {
      ...bundle.request,
      text: redactText(bundle.request.text, 10_000),
    },
  };
}
