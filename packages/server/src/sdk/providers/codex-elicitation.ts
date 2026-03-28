import { getLogger } from "../../logging/logger.js";
import type { ToolApprovalResult } from "../types.js";
import type { StartSessionOptions } from "./types.js";

const log = getLogger().child({ component: "codex-provider" });

export interface CodexMcpElicitationSchemaProperty {
  type?: unknown;
  title?: unknown;
  description?: unknown;
  enum?: unknown;
}

export interface CodexMcpElicitationRequestParams {
  message?: string;
  serverName?: string;
  requestedSchema?: {
    type?: unknown;
    properties?: Record<string, CodexMcpElicitationSchemaProperty>;
    required?: unknown;
  };
  url?: string;
}

export interface CodexElicitationField {
  field: string;
  questionKey: string;
  type: "string" | "number" | "integer" | "boolean";
}

export interface CodexElicitationToolInput {
  questions: Array<{
    question: string;
    header: string;
    options: Array<{ label: string; description: string }>;
    multiSelect: boolean;
  }>;
  elicitationFields: CodexElicitationField[];
  answers?: Record<string, string>;
}

export interface CodexMcpElicitationResponse {
  action: "accept" | "decline" | "cancel";
  content?: Record<string, unknown>;
}

export interface JsonRpcServerRequestLike {
  id: string | number;
  method: string;
  params?: unknown;
}

export function asMcpElicitationRequestParams(
  params: unknown,
): CodexMcpElicitationRequestParams | null {
  if (!params || typeof params !== "object") return null;
  const record = params as Record<string, unknown>;
  const hasUrl = typeof record.url === "string" && record.url.length > 0;
  const hasRequestedSchema =
    !!record.requestedSchema && typeof record.requestedSchema === "object";

  if (!hasUrl && !hasRequestedSchema) {
    return null;
  }

  return params as CodexMcpElicitationRequestParams;
}

export function buildMcpElicitationToolInput(
  params: CodexMcpElicitationRequestParams,
  getOptionalString: (value: unknown) => string | null,
): CodexElicitationToolInput | null {
  const schema = params.requestedSchema;
  const properties =
    schema?.properties && typeof schema.properties === "object"
      ? schema.properties
      : null;
  if (!properties || Object.keys(properties).length === 0) {
    return null;
  }

  const questions: CodexElicitationToolInput["questions"] = [];
  const elicitationFields: CodexElicitationField[] = [];

  for (const [field, property] of Object.entries(properties)) {
    const rawType =
      typeof property.type === "string" ? property.type : undefined;
    if (rawType === "object" || rawType === "array") {
      return null;
    }

    const fieldType: CodexElicitationField["type"] =
      rawType === "boolean" ||
      rawType === "number" ||
      rawType === "integer" ||
      rawType === "string"
        ? rawType
        : "string";

    const title = getOptionalString(property.title) ?? field;
    const description = getOptionalString(property.description) ?? "";
    const questionKey = description ? `${title}: ${description}` : title;
    const enumValues = Array.isArray(property.enum)
      ? property.enum.filter(
          (value): value is string | number | boolean =>
            typeof value === "string" ||
            typeof value === "number" ||
            typeof value === "boolean",
        )
      : [];

    const options =
      fieldType === "boolean"
        ? [
            { label: "Yes", description: "" },
            { label: "No", description: "" },
          ]
        : enumValues.map((value) => ({
            label: String(value),
            description: "",
          }));

    questions.push({
      question: questionKey,
      header: title,
      options,
      multiSelect: false,
    });
    elicitationFields.push({
      field,
      questionKey,
      type: fieldType,
    });
  }

  return {
    questions,
    elicitationFields,
  };
}

export function buildMcpElicitationContent(
  input: CodexElicitationToolInput,
): Record<string, unknown> {
  const answers =
    input.answers && typeof input.answers === "object" ? input.answers : {};
  const content: Record<string, unknown> = {};

  for (const field of input.elicitationFields) {
    const value = answers[field.questionKey];
    if (typeof value !== "string") continue;

    switch (field.type) {
      case "boolean":
        content[field.field] =
          value.toLowerCase() === "yes"
            ? true
            : value.toLowerCase() === "no"
              ? false
              : value.toLowerCase() === "true";
        break;
      case "number": {
        const parsed = Number(value);
        content[field.field] = Number.isFinite(parsed) ? parsed : value;
        break;
      }
      case "integer": {
        const parsed = Number.parseInt(value, 10);
        content[field.field] = Number.isFinite(parsed) ? parsed : value;
        break;
      }
      case "string":
        content[field.field] = value;
        break;
    }
  }

  return content;
}

export async function handleMcpServerElicitationRequest(
  request: JsonRpcServerRequestLike,
  options: StartSessionOptions,
  signal: AbortSignal,
  deps: {
    getOptionalString: (value: unknown) => string | null;
    resolveApprovalDecision: <TDecision extends string>(
      options: StartSessionOptions,
      toolName: string,
      toolInput: unknown,
      signal: AbortSignal,
      allowDecision: TDecision,
      denyDecision: TDecision,
    ) => Promise<TDecision>;
  },
): Promise<CodexMcpElicitationResponse> {
  const elicitation = asMcpElicitationRequestParams(request.params);
  if (!elicitation) {
    log.warn(
      { method: request.method, requestId: request.id },
      "Codex elicitation params invalid; canceling",
    );
    return { action: "cancel" };
  }

  if (elicitation.url) {
    const action = await deps.resolveApprovalDecision(
      options,
      "OpenUrl",
      {
        url: elicitation.url,
        message: elicitation.message ?? null,
        serverName: elicitation.serverName ?? null,
      },
      signal,
      "accept",
      "decline",
    );
    return { action };
  }

  const toolInput = buildMcpElicitationToolInput(
    elicitation,
    deps.getOptionalString,
  );
  if (!toolInput) {
    log.warn(
      {
        method: request.method,
        requestId: request.id,
        serverName: elicitation.serverName ?? null,
      },
      "Codex elicitation schema unsupported; canceling",
    );
    return { action: "cancel" };
  }

  if (!options.onToolApproval) {
    log.warn(
      { method: request.method, requestId: request.id },
      "No onToolApproval handler available; canceling Codex elicitation",
    );
    return { action: "cancel" };
  }

  let result: ToolApprovalResult;
  try {
    result = await options.onToolApproval("AskUserQuestion", toolInput, {
      signal,
    });
  } catch (error) {
    log.warn(
      { method: request.method, requestId: request.id, error },
      "onToolApproval threw while handling Codex elicitation",
    );
    return { action: "cancel" };
  }

  if (result.behavior !== "allow") {
    return { action: "decline" };
  }

  const updatedInput = (result.updatedInput ??
    toolInput) as CodexElicitationToolInput;
  return {
    action: "accept",
    content: buildMcpElicitationContent(updatedInput),
  };
}
