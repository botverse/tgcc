/**
 * Minimal type declarations for openclaw/plugin-sdk.
 *
 * These stubs provide compile-time types for the plugin. At runtime,
 * the actual types come from the OpenClaw host that loads this plugin.
 */
declare module "openclaw/plugin-sdk" {
  // Minimal schema type — compatible with JSON Schema objects (no typebox dep required)
  type TSchema = Record<string, unknown>;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  type Static<T> = Record<string, unknown>;

  // ── Logger ──

  export type PluginLogger = {
    debug?: (message: string) => void;
    info: (message: string) => void;
    warn: (message: string) => void;
    error?: (message: string) => void;
  };

  // ── Tool types ──

  export type AgentToolResult<T = unknown> = {
    content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;
    details: T;
  };

  export type AgentToolUpdateCallback<T = unknown> = (partialResult: AgentToolResult<T>) => void;

  export interface AnyAgentTool {
    name: string;
    description: string;
    label: string;
    parameters: TSchema;
    execute: (
      toolCallId: string,
      params: Record<string, unknown>,
      signal?: AbortSignal,
      onUpdate?: AgentToolUpdateCallback,
    ) => Promise<AgentToolResult>;
    ownerOnly?: boolean;
  }

  // ── Gateway types ──

  export type RespondFn = (
    ok: boolean,
    payload?: unknown,
    error?: unknown,
    meta?: Record<string, unknown>,
  ) => void;

  export type GatewayRequestHandlerOptions = {
    params: Record<string, unknown>;
    respond: RespondFn;
    [key: string]: unknown;
  };

  export type GatewayRequestHandler = (
    opts: GatewayRequestHandlerOptions,
  ) => Promise<void> | void;

  // ── Service types ──

  export type OpenClawPluginServiceContext = {
    config: unknown;
    workspaceDir?: string;
    stateDir: string;
    logger: PluginLogger;
  };

  export type OpenClawPluginService = {
    id: string;
    start: (ctx: OpenClawPluginServiceContext) => void | Promise<void>;
    stop?: (ctx: OpenClawPluginServiceContext) => void | Promise<void>;
  };

  // ── Runtime types ──

  export type PluginRuntime = {
    version: string;
    config: {
      loadConfig: () => unknown;
    };
    system: {
      enqueueSystemEvent: (event: unknown) => void;
      [key: string]: unknown;
    };
    channel: {
      telegram: {
        sendMessageTelegram: (
          target: string | number,
          text: string,
          opts?: Record<string, unknown>,
        ) => Promise<unknown>;
        [key: string]: unknown;
      };
      [key: string]: unknown;
    };
    logging: {
      getChildLogger: (
        bindings?: Record<string, unknown>,
        opts?: Record<string, unknown>,
      ) => PluginLogger;
      [key: string]: unknown;
    };
    [key: string]: unknown;
  };

  // ── Plugin API ──

  export type OpenClawPluginToolOptions = {
    name?: string;
    names?: string[];
    optional?: boolean;
  };

  export type OpenClawPluginApi = {
    id: string;
    name: string;
    version?: string;
    description?: string;
    source: string;
    config: unknown;
    pluginConfig?: Record<string, unknown>;
    runtime: PluginRuntime;
    logger: PluginLogger;
    registerTool: (
      tool: AnyAgentTool,
      opts?: OpenClawPluginToolOptions,
    ) => void;
    registerService: (service: OpenClawPluginService) => void;
    registerGatewayMethod: (
      method: string,
      handler: GatewayRequestHandler,
    ) => void;
    registerHook: (
      events: string | string[],
      handler: (...args: unknown[]) => void | Promise<void>,
      opts?: Record<string, unknown>,
    ) => void;
    registerHttpRoute: (params: {
      path: string;
      handler: (req: unknown, res: unknown) => void | Promise<void>;
    }) => void;
    registerCommand: (command: {
      name: string;
      description: string;
      acceptsArgs?: boolean;
      handler: (...args: unknown[]) => void | Promise<void>;
    }) => void;
    on: (
      hookName: string,
      handler: (...args: unknown[]) => void | Promise<void>,
      opts?: { priority?: number },
    ) => void;
    resolvePath: (input: string) => string;
  };

  // ── Plugin shape ──

  export type OpenClawPluginConfigSchema = {
    parse: (value: unknown) => unknown;
    uiHints?: Record<string, unknown>;
  };
}
