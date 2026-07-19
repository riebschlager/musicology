export const ExitCode = {
  Success: 0,
  InternalError: 1,
  UsageError: 2,
  ConfigurationError: 3,
  DataError: 4,
} as const;

export type ExitCode = (typeof ExitCode)[keyof typeof ExitCode];
export type ErrorExitCode = Exclude<ExitCode, typeof ExitCode.Success>;
export type OutputFormat = "human" | "json";

export type JsonPrimitive = boolean | null | number | string;
export type JsonValue = JsonPrimitive | readonly JsonValue[] | JsonObject;
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

export interface CommandError {
  readonly code: string;
  readonly message: string;
}

export interface CommandResult<T extends JsonValue = JsonObject> {
  readonly command: string;
  readonly status: "success" | "error";
  readonly exitCode: ExitCode;
  readonly summary: string;
  readonly data?: T;
  readonly errors?: readonly CommandError[];
}

export function commandSuccess<T extends JsonValue>(
  command: string,
  summary: string,
  data: T,
): CommandResult<T>;
export function commandSuccess(command: string, summary: string): CommandResult;
export function commandSuccess<T extends JsonValue>(
  command: string,
  summary: string,
  data?: T,
): CommandResult<T> {
  return {
    command,
    status: "success",
    exitCode: ExitCode.Success,
    summary,
    ...(data === undefined ? {} : { data }),
  };
}

export function commandFailure(
  command: string,
  exitCode: ErrorExitCode,
  summary: string,
  errors: readonly CommandError[],
): CommandResult {
  return {
    command,
    status: "error",
    exitCode,
    summary,
    errors,
  };
}

export function redactSensitiveText(text: string, sensitiveValues: readonly string[]): string {
  const values = [...new Set(sensitiveValues.filter((value) => value !== ""))].sort(
    (left, right) => right.length - left.length,
  );

  return values.reduce((redacted, value) => redacted.replaceAll(value, "[REDACTED]"), text);
}

function redactJsonValue(value: JsonValue, sensitiveValues: readonly string[]): JsonValue {
  if (typeof value === "string") {
    return redactSensitiveText(value, sensitiveValues);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactJsonValue(item, sensitiveValues));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, redactJsonValue(item, sensitiveValues)]),
    );
  }
  return value;
}

function redactResult<T extends JsonValue>(
  result: CommandResult<T>,
  sensitiveValues: readonly string[],
): CommandResult<JsonValue> {
  return {
    command: redactSensitiveText(result.command, sensitiveValues),
    status: result.status,
    exitCode: result.exitCode,
    summary: redactSensitiveText(result.summary, sensitiveValues),
    ...(result.data === undefined ? {} : { data: redactJsonValue(result.data, sensitiveValues) }),
    ...(result.errors === undefined
      ? {}
      : {
          errors: result.errors.map((error) => ({
            code: error.code,
            message: redactSensitiveText(error.message, sensitiveValues),
          })),
        }),
  };
}

export interface RenderCommandResultOptions {
  readonly format?: OutputFormat;
  readonly sensitiveValues?: readonly string[];
}

export function renderCommandResult<T extends JsonValue>(
  result: CommandResult<T>,
  options: RenderCommandResultOptions = {},
): string {
  const safeResult = redactResult(result, options.sensitiveValues ?? []);
  if ((options.format ?? "human") === "json") {
    return `${JSON.stringify(safeResult)}\n`;
  }

  const lines = [safeResult.summary];
  for (const error of safeResult.errors ?? []) {
    lines.push(`Error [${error.code}]: ${error.message}`);
  }
  if (safeResult.data !== undefined) {
    lines.push(JSON.stringify(safeResult.data, undefined, 2));
  }
  return `${lines.join("\n")}\n`;
}
