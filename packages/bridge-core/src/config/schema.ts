import { z } from "zod";

const servicePortSchema = z.number().int().min(10_001).max(65_535);

const commandSchema = z.array(z.string().min(1)).min(1);

const environmentVariableSchema = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "Expected an environment variable name");

const readySchema = z
  .object({
    path: z.string().startsWith("/").default("/"),
    timeoutMs: z.number().int().positive().default(60_000),
  })
  .strict();

const verificationCommandSchema = z
  .object({
    name: z.string().min(1),
    command: commandSchema,
    timeoutMs: z.number().int().positive().default(120_000),
  })
  .strict();

export const visualDevConfigSchema = z
  .object({
    version: z.literal(1),
    project: z
      .object({
        id: z.string().trim().min(1),
        workspace: z.string().trim().min(1),
      })
      .strict(),
    gateway: z
      .object({
        host: z.string().trim().min(1),
        port: servicePortSchema.or(z.literal("auto")),
        publicUrl: z.string().url().optional(),
      })
      .strict(),
    upstream: z
      .object({
        url: z.string().url().optional(),
        port: servicePortSchema.or(z.literal("auto")),
        command: commandSchema.optional(),
        ready: readySchema,
      })
      .strict(),
    agent: z
      .object({
        adapter: z.enum(["codex", "claude", "opencode"]),
        model: z.string().trim().min(1).optional(),
        reasoningEffort: z
          .enum(["minimal", "low", "medium", "high", "xhigh", "max"])
          .optional(),
        profile: z
          .string()
          .trim()
          .regex(
            /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/,
            "Expected a Codex profile name",
          )
          .optional(),
        inheritEnv: z.array(environmentVariableSchema).default([]),
        maxRunMs: z.number().int().positive(),
        resumeMode: z.enum(["auto", "new"]).default("auto"),
      })
      .strict()
      .superRefine((agent, context) => {
        if (agent.adapter === "claude" && agent.reasoningEffort === "minimal") {
          context.addIssue({
            code: "custom",
            path: ["reasoningEffort"],
            message: "minimal reasoning effort is only supported by the Codex adapter",
          });
        }
        if (agent.adapter === "codex" && agent.reasoningEffort === "max") {
          context.addIssue({
            code: "custom",
            path: ["reasoningEffort"],
            message: "max reasoning effort is only supported by the Claude adapter",
          });
        }
        if (agent.adapter !== "codex" && agent.profile !== undefined) {
          context.addIssue({
            code: "custom",
            path: ["profile"],
            message: "agent.profile is only supported by the Codex adapter",
          });
        }
      }),
    queue: z
      .object({
        maxPending: z.number().int().positive(),
      })
      .strict(),
    context: z
      .object({
        maxElements: z.number().int().positive(),
        maxRegionElements: z.number().int().positive(),
        maxTextLength: z.number().int().positive(),
        includeComputedStyles: z.boolean(),
        includeScreenshot: z.enum(["never", "best-effort", "always"]),
      })
      .strict(),
    verification: z
      .object({
        hmrWaitMs: z.number().int().nonnegative(),
        commands: z.array(verificationCommandSchema),
      })
      .strict(),
    paths: z
      .object({
        allowed: z.array(z.string().min(1)),
        denied: z.array(z.string().min(1)),
      })
      .strict(),
    security: z
      .object({
        allowedOrigins: z.array(z.string().url()),
        rotatePairingTokenOnStart: z.boolean(),
      })
      .strict(),
  })
  .strict();

export type VisualDevConfig = z.infer<typeof visualDevConfigSchema>;

export function createDefaultConfig(projectId: string): VisualDevConfig {
  return {
    version: 1,
    project: {
      id: projectId,
      workspace: ".",
    },
    gateway: {
      host: "127.0.0.1",
      port: 10_001,
    },
    upstream: {
      port: "auto",
      ready: {
        path: "/",
        timeoutMs: 60_000,
      },
    },
    agent: {
      adapter: "codex",
      inheritEnv: [],
      maxRunMs: 900_000,
      resumeMode: "auto",
    },
    queue: {
      maxPending: 20,
    },
    context: {
      maxElements: 8,
      maxRegionElements: 20,
      maxTextLength: 500,
      includeComputedStyles: true,
      includeScreenshot: "best-effort",
    },
    verification: {
      hmrWaitMs: 12_000,
      commands: [],
    },
    paths: {
      allowed: [
        "app/**",
        "pages/**",
        "src/**",
        "components/**",
        "styles/**",
        "public/**",
        "tests/**",
        "package.json",
      ],
      denied: [
        ".git/**",
        ".env",
        ".env.*",
        "**/*.pem",
        "**/*.key",
        "node_modules/**",
        ".next/**",
        "dist/**",
      ],
    },
    security: {
      allowedOrigins: [],
      rotatePairingTokenOnStart: true,
    },
  };
}
