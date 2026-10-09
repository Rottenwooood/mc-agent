// Runtime configuration for the observation backend (the read-only observer mod).

export interface ObserverConfig {
  baseUrl: string;
  token?: string;
  timeoutMs: number;
}

export function observerConfigFromEnv(env: NodeJS.ProcessEnv = process.env): ObserverConfig {
  const cfg: ObserverConfig = {
    baseUrl: env.MCAGENT_OBSERVER ?? 'http://127.0.0.1:8765',
    timeoutMs: Number(env.MCAGENT_OBSERVER_TIMEOUT_MS ?? 5000),
  };
  const token = env.MCAGENT_OBSERVER_TOKEN;
  if (token) cfg.token = token;
  return cfg;
}

/** Runtime configuration for the client-controller mod (local-player control). */
export interface ControlConfig {
  baseUrl: string;
  token?: string;
  /** Control ops can span many ticks (goto/smelt/...); this must be generous. */
  timeoutMs: number;
}

export function controlConfigFromEnv(env: NodeJS.ProcessEnv = process.env): ControlConfig {
  const cfg: ControlConfig = {
    baseUrl: env.MCAGENT_CONTROL_URL ?? 'http://127.0.0.1:8766',
    timeoutMs: Number(env.MCAGENT_CONTROL_TIMEOUT_MS ?? 120000),
  };
  const token = env.MCAGENT_CONTROL_TOKEN;
  if (token) cfg.token = token;
  return cfg;
}
