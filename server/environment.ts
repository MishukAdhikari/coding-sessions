type Environment = Record<string, string | undefined>;

/** CS is canonical; read the previous prefix only to keep existing installs working. */
export function readCsSetting(env: Environment, name: `CS_${string}`): string | undefined {
  return env[name] ?? env[`X${name}`];
}
