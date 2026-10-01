import * as z from "zod/v4";

const identifier = z.string().trim().min(1).max(200);
const message = z.string().trim().min(1).max(1_000);
const statusQueryArguments = z.strictObject({
  query: z.discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("job"),
      id: identifier,
      waitFor: z.enum(["change", "terminal"]).optional(),
      waitMs: z.number().int().min(1).max(60_000).optional()
    }).refine(
      (query) => query.waitMs === undefined || query.waitFor !== undefined,
      "waitFor is required whenever waitMs is sent."
    ),
    z.strictObject({ kind: z.literal("activity"), id: identifier }),
    z.strictObject({ kind: z.literal("thread"), id: identifier }),
    z.strictObject({
      kind: z.literal("input"),
      jobId: identifier,
      afterCursor: z.string().regex(/^[a-f0-9]{64}$/).optional(),
      waitMs: z.number().int().min(0).max(60_000).optional()
    }),
    z.strictObject({ kind: z.literal("project"), name: z.string().trim().min(1).max(240) })
  ]).optional()
});

/**
 * The Dashboard is a render tool. An admitted task can ask the model to
 * render the originating conversation with a scoped Job handle, while an
 * ordinary Dashboard opener remains argument-free.
 */
const dashboardArguments = z.strictObject({
  scope: z.literal("conversation").optional(),
  jobId: z.string().uuid().optional(),
  presentationRef: z.string().regex(/^[a-f0-9]{64}$/).optional()
}).superRefine((value, context) => {
  if (value.jobId && value.scope !== "conversation") {
    context.addIssue({
      code: "custom",
      path: ["scope"],
      message: "jobId requires the originating conversation scope."
    });
  }
  if (Boolean(value.jobId) !== Boolean(value.presentationRef)) {
    context.addIssue({
      code: "custom",
      path: value.jobId ? ["presentationRef"] : ["jobId"],
      message: "jobId and presentationRef must be supplied together."
    });
  }
});

/**
 * Model-visible recovery is deliberately a closed set of non-destructive
 * reads/openers plus a separate guidance branch. A recovery record never
 * authorizes a task, mutation, or cancellation by itself.
 * Status shares this JSON Schema definition across its result branches.
 */
export const modelNextActionOutputSchema = z.union([
  z.strictObject({
    kind: z.literal("tool"),
    tool: z.literal("codex_models"),
    arguments: z.strictObject({ refresh: z.boolean().optional() }),
    message: message.optional()
  }),
  z.strictObject({
    kind: z.literal("tool"),
    tool: z.literal("codex_settings"),
    arguments: z.strictObject({ refreshModels: z.boolean().optional() }),
    message: message.optional()
  }),
  z.strictObject({
    kind: z.literal("tool"),
    tool: z.literal("codex_status"),
    arguments: statusQueryArguments,
    message: message.optional()
  }),
  z.strictObject({
    kind: z.literal("tool"),
    tool: z.literal("codex_dashboard"),
    arguments: dashboardArguments,
    message: message.optional()
  }),
  z.strictObject({ kind: z.literal("guidance"), message })
]).meta({ id: "modelNextAction" });

export type ModelNextAction = z.infer<typeof modelNextActionOutputSchema>;

export function guidance(value: string): ModelNextAction {
  const normalized = value.replace(/\s+/g, " ").trim().slice(0, 1_000);
  return modelNextActionOutputSchema.parse({
    kind: "guidance",
    message: normalized || "Inspect the current authoritative state before deciding the next action."
  });
}

export function modelsAction(refresh = true, actionMessage?: string): ModelNextAction {
  return modelNextActionOutputSchema.parse({
    kind: "tool",
    tool: "codex_models",
    arguments: { refresh },
    ...(actionMessage ? { message: actionMessage } : {})
  });
}

export function settingsAction(actionMessage?: string): ModelNextAction {
  return modelNextActionOutputSchema.parse({
    kind: "tool",
    tool: "codex_settings",
    arguments: {},
    ...(actionMessage ? { message: actionMessage } : {})
  });
}

export function statusAction(
  argumentsValue: z.infer<typeof statusQueryArguments> = {},
  actionMessage?: string
): ModelNextAction {
  return modelNextActionOutputSchema.parse({
    kind: "tool",
    tool: "codex_status",
    arguments: argumentsValue,
    ...(actionMessage ? { message: actionMessage } : {})
  });
}

/**
 * Projects previous result records into the new closed action contract. This
 * is a one-way output projection: unknown or mutating actions turn into
 * guidance rather than becoming executable tool calls.
 */
export function projectModelNextAction(value: unknown): ModelNextAction {
  if (typeof value === "string") return guidance(value);
  if (!record(value)) return guidance("Inspect the current authoritative state before deciding the next action.");

  const direct = modelNextActionOutputSchema.safeParse(value);
  if (direct.success) return direct.data;

  const rawTool = typeof value.tool === "string" ? value.tool : undefined;
  const rawArguments = record(value.arguments) ? value.arguments : {};
  const rawMessage = typeof value.userPrompt === "string"
    ? value.userPrompt
    : typeof value.message === "string"
      ? value.message
      : undefined;
  if (rawTool) {
    const candidate = modelNextActionOutputSchema.safeParse({
      kind: "tool",
      tool: rawTool,
      arguments: rawArguments,
      ...(rawMessage ? { message: rawMessage } : {})
    });
    if (candidate.success) return candidate.data;
  }

  // A retained cancellation hint is never translated into an executable stop.
  // It may point at an exact Job, which is safe to inspect first.
  if (rawTool === "codex_cancel") {
    const jobId = identifier.safeParse(rawArguments.jobId);
    return statusAction(
      jobId.success ? { query: { kind: "job", id: jobId.data } } : {},
      "Inspect the current target before deciding whether an explicit stop is still authorized."
    );
  }
  return guidance(rawMessage || "Inspect the current authoritative state before deciding the next action.");
}

export function nextActionSummary(action: ModelNextAction): string {
  if (action.kind === "guidance") return action.message;
  const call = `${action.tool}(${JSON.stringify(action.arguments)})`;
  return action.message ? `${call}. ${action.message}` : call;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
