import path from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_PRESENTATION_TIMEZONE = "America/Chicago";

export const CONFIGURATION_VARIABLES = {
  dataDirectory: "MUSICOLOGY_DATA_DIR",
  databasePath: "MUSICOLOGY_DATABASE_PATH",
  inputsDirectory: "MUSICOLOGY_INPUTS_DIR",
  lastfmApiKey: "LASTFM_API_KEY",
  lastfmUsername: "LASTFM_USERNAME",
  outputsDirectory: "MUSICOLOGY_OUTPUTS_DIR",
  presentationTimezone: "MUSICOLOGY_TIMEZONE",
} as const;

export interface DataPaths {
  readonly dataDirectory: string;
  readonly databasePath: string;
  readonly inputsDirectory: string;
  readonly outputsDirectory: string;
}

export interface LastfmConfiguration {
  readonly apiKey?: string;
  readonly username?: string;
}

export interface ProjectConfiguration {
  readonly paths: DataPaths;
  readonly presentationTimezone: string;
  readonly lastfm: LastfmConfiguration;
}

export interface ConfigurationIssue {
  readonly code: "invalid_path" | "invalid_timezone" | "invalid_value";
  readonly variable: string;
  readonly message: string;
}

export class ConfigurationError extends Error {
  readonly issues: readonly ConfigurationIssue[];

  constructor(issues: readonly ConfigurationIssue[]) {
    super(`Invalid configuration: ${issues.map((issue) => issue.message).join("; ")}`);
    this.name = "ConfigurationError";
    this.issues = issues;
  }
}

export type ConfigurationEnvironment = Readonly<Record<string, string | undefined>>;

export interface LoadConfigurationOptions {
  readonly environment?: ConfigurationEnvironment;
  readonly repositoryRoot?: string;
}

export const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));

function validatePathOverride(variable: string, value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (value.trim() === "" || value.includes("\0")) {
    throw new ConfigurationError([
      {
        code: "invalid_path",
        variable,
        message: `${variable} must be a non-empty filesystem path`,
      },
    ]);
  }

  return value;
}

function resolveConfiguredPath(root: string, configuredPath: string): string {
  return path.isAbsolute(configuredPath)
    ? path.normalize(configuredPath)
    : path.resolve(root, configuredPath);
}

function validateTimezone(value: string): string {
  if (value.trim() === "") {
    throw new ConfigurationError([
      {
        code: "invalid_timezone",
        variable: CONFIGURATION_VARIABLES.presentationTimezone,
        message: `${CONFIGURATION_VARIABLES.presentationTimezone} must name an IANA timezone`,
      },
    ]);
  }

  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(0);
  } catch {
    throw new ConfigurationError([
      {
        code: "invalid_timezone",
        variable: CONFIGURATION_VARIABLES.presentationTimezone,
        message: `${CONFIGURATION_VARIABLES.presentationTimezone} must name a valid IANA timezone`,
      },
    ]);
  }

  return value;
}

function readOptionalLastfmValue(
  environment: ConfigurationEnvironment,
  variable: string,
): string | undefined {
  const value = environment[variable];
  if (value === undefined || value === "") {
    return undefined;
  }

  if (value.trim() === "" || /\p{Cc}/u.test(value)) {
    throw new ConfigurationError([
      {
        code: "invalid_value",
        variable,
        message: `${variable} must be non-empty and must not contain control characters`,
      },
    ]);
  }

  return value;
}

export function loadConfiguration(options: LoadConfigurationOptions = {}): ProjectConfiguration {
  const environment = options.environment ?? process.env;
  const root = path.resolve(options.repositoryRoot ?? repositoryRoot);

  const dataDirectoryOverride = validatePathOverride(
    CONFIGURATION_VARIABLES.dataDirectory,
    environment[CONFIGURATION_VARIABLES.dataDirectory],
  );
  const dataDirectory = resolveConfiguredPath(root, dataDirectoryOverride ?? "data");

  const inputsDirectory = resolveConfiguredPath(
    root,
    validatePathOverride(
      CONFIGURATION_VARIABLES.inputsDirectory,
      environment[CONFIGURATION_VARIABLES.inputsDirectory],
    ) ?? path.join(dataDirectory, "inputs"),
  );
  const databasePath = resolveConfiguredPath(
    root,
    validatePathOverride(
      CONFIGURATION_VARIABLES.databasePath,
      environment[CONFIGURATION_VARIABLES.databasePath],
    ) ?? path.join(dataDirectory, "database", "musicology.sqlite3"),
  );
  const outputsDirectory = resolveConfiguredPath(
    root,
    validatePathOverride(
      CONFIGURATION_VARIABLES.outputsDirectory,
      environment[CONFIGURATION_VARIABLES.outputsDirectory],
    ) ?? path.join(dataDirectory, "outputs"),
  );

  const username = readOptionalLastfmValue(environment, CONFIGURATION_VARIABLES.lastfmUsername);
  const apiKey = readOptionalLastfmValue(environment, CONFIGURATION_VARIABLES.lastfmApiKey);

  return {
    paths: {
      dataDirectory,
      databasePath,
      inputsDirectory,
      outputsDirectory,
    },
    presentationTimezone: validateTimezone(
      environment[CONFIGURATION_VARIABLES.presentationTimezone] ?? DEFAULT_PRESENTATION_TIMEZONE,
    ),
    lastfm: {
      ...(username === undefined ? {} : { username }),
      ...(apiKey === undefined ? {} : { apiKey }),
    },
  };
}

export function configurationRedactionValues(
  configuration: ProjectConfiguration,
): readonly string[] {
  return [configuration.lastfm.apiKey, configuration.lastfm.username].filter(
    (value): value is string => value !== undefined && value !== "",
  );
}
