type Environment = Record<string, string | undefined>;

export function readCsSetting(env: Environment, name: `CS_${string}`): string | undefined {
  return env[name];
}
