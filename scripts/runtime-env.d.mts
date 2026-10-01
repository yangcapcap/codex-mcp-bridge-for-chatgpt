export type RuntimeEnvStatus = {
  path: string;
  exists: boolean;
  valid: boolean;
  hasApiKey: boolean;
  hasTunnelId: boolean;
  tunnelId: string | null;
  operatorConfiguration: RuntimeOperatorConfiguration;
  issue: string | null;
  issueProblem: StatusProblem | null;
};

export type StatusProblem = {
  code: string;
  arguments: Record<string, string>;
};

export type RuntimeOperatorConfiguration = {
  defaultBackend: "app-server";
  maximumAccess: "read-only" | "workspace-write" | "full-access";
};

export function defaultRuntimeEnvFile(options?: {
  environment?: NodeJS.ProcessEnv;
  homeDirectory?: string;
}): string;

export function inspectRuntimeEnvFile(filePath: string): RuntimeEnvStatus;

export function repairRuntimeEnvPermissions(filePath: string): RuntimeEnvStatus;

export function loadRuntimeEnvFile(
  filePath: string,
  options?: {
    required?: boolean;
    allowedKey?: (key: string) => boolean;
    platform?: NodeJS.Platform;
    uid?: number;
  }
): boolean;

export function readRuntimeEnvSubset(
  filePath: string,
  keys: string[],
  options?: {
    platform?: NodeJS.Platform;
    uid?: number;
    allowBroadReadOnlyPermissions?: boolean;
  }
): Record<string, string>;

export const CODEX_CHILD_ENV_KEYS: readonly string[];
export function codexChildEnvironment(
  filePath?: string,
  inherited?: NodeJS.ProcessEnv
): NodeJS.ProcessEnv;
export function codexChildEnvironmentFingerprint(environment: NodeJS.ProcessEnv): string;
export const CODEX_APPLIED_ENV_KEYS: readonly string[];
export function codexAppliedEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
export function codexProcessEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
export function mcpOAuthRequested(environment: NodeJS.ProcessEnv): boolean;
export function isLoopbackOAuthMetadataUrl(value: string, host: string, port: number | string): boolean;
export function mcpOAuthEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv;

export type PreparedRuntimeEnvUpdate = {
  readonly path: string;
  readonly directory: string;
  readonly existed: boolean;
  readonly original: string;
  readonly next: string;
  readonly changed: boolean;
  readonly tunnelIdChanged: boolean;
  readonly platform: NodeJS.Platform;
  readonly uid: number | undefined;
};

export function prepareRuntimeEnvUpdate(
  filePath: string,
  values: {
    apiKey?: string;
    tunnelId?: string;
    defaultBackend?: RuntimeOperatorConfiguration["defaultBackend"];
    maximumAccess?: RuntimeOperatorConfiguration["maximumAccess"];
  }
): PreparedRuntimeEnvUpdate;

export function commitRuntimeEnvUpdate(
  prepared: PreparedRuntimeEnvUpdate
): RuntimeEnvStatus;

export function rollbackRuntimeEnvUpdate(
  prepared: PreparedRuntimeEnvUpdate
): RuntimeEnvStatus;

export function updateRuntimeEnvFile(
  filePath: string,
  values: {
    apiKey?: string;
    tunnelId?: string;
    defaultBackend?: RuntimeOperatorConfiguration["defaultBackend"];
    maximumAccess?: RuntimeOperatorConfiguration["maximumAccess"];
  }
): RuntimeEnvStatus;
