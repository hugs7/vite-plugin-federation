import type {
  ConfigEnv,
  ResolvedConfig,
  UserConfig,
  ViteDevServer,
  Rolldown
} from 'vite';

export interface PluginHooks {
  name: string;
  virtualFile?: Record<string, unknown>;
  options?: (
    this: Rolldown.MinimalPluginContext,
    options: Rolldown.InputOptions
  ) => void;
  config?: (
    this: unknown,
    config: UserConfig,
    env: ConfigEnv
  ) => void | Promise<void>;
  configureServer?: (
    this: unknown,
    server: ViteDevServer
  ) => void | Promise<void>;
  configResolved?: (this: unknown, config: ResolvedConfig) => void;
  buildStart?: (
    this: Rolldown.PluginContext,
    options: Rolldown.NormalizedInputOptions
  ) => void | Promise<void>;
  resolveId?: (
    this: Rolldown.PluginContext,
    source: string,
    importer: string | undefined,
    options: Record<string, unknown>
  ) => Rolldown.ResolveIdResult | Promise<Rolldown.ResolveIdResult>;
  load?: (
    this: Rolldown.PluginContext,
    id: string,
    options?: Record<string, unknown>
  ) => Rolldown.LoadResult | Promise<Rolldown.LoadResult>;
  transform?: (
    this: Rolldown.TransformPluginContext,
    code: string,
    id: string,
    options?: Record<string, unknown>
  ) => Rolldown.TransformResult | Promise<Rolldown.TransformResult>;
  moduleParsed?: (
    this: Rolldown.PluginContext,
    moduleInfo: Rolldown.ModuleInfo
  ) => void | Promise<void>;
  outputOptions?: (
    this: Rolldown.MinimalPluginContext,
    options: Rolldown.OutputOptions
  ) => void;
  renderChunk?: (
    this: Rolldown.PluginContext,
    code: string,
    chunk: Rolldown.RenderedChunk,
    options: Rolldown.NormalizedOutputOptions
  ) => string | { code: string } | null | Promise<string | { code: string } | null>;
  generateBundle?: (
    this: Rolldown.PluginContext,
    options: Rolldown.NormalizedOutputOptions,
    bundle: Rolldown.OutputBundle,
    isWrite: boolean
  ) => void | Promise<void>;
}
