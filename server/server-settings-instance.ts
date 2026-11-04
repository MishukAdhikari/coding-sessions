import { join } from "node:path";
import { config } from "./config";
import { deleteMeta, getMeta, setMeta } from "./db";
import { readCsSetting } from "./environment";
import { createServerSettings, type ServerSettingName } from "./server-settings";

const listeners = new Set<(name: ServerSettingName) => void>();

/** The app's live server settings: saved in Settings, else this server's environment. */
export const serverSettings = createServerSettings({
  store: { get: getMeta, set: setMeta, delete: deleteMeta },
  env: process.env,
  // Only hosts set up with the installer have a root updater to read the channel.
  channelFile: readCsSetting(process.env, "CS_APP_UPDATE_STATUS") ? join(config.dataDir, "app-update-channel") : null,
  onChange: (name) => { for (const listener of listeners) listener(name); },
});

export function onServerSettingChange(listener: (name: ServerSettingName) => void): void {
  listeners.add(listener);
}
