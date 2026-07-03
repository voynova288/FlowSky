import type { UserSettings } from "../../types.ts";

export const DEFAULT_USER_SETTINGS: UserSettings = {
  memory_enabled: true,
  proactive_enabled: false,
  romance_realism_level: 1,
  voice_enabled: false,
  avatar_enabled: false,
  adult_romance_enabled: true,
};

export interface SettingsStoreLike {
  get(userId: string): UserSettings;
  update(userId: string, patch: Partial<UserSettings>): UserSettings;
}

export class SettingsStore implements SettingsStoreLike {
  private readonly settings = new Map<string, UserSettings>();

  get(userId: string): UserSettings {
    return this.settings.get(userId) ?? { ...DEFAULT_USER_SETTINGS };
  }

  update(userId: string, patch: Partial<UserSettings>): UserSettings {
    const next = { ...this.get(userId), ...patch };
    this.settings.set(userId, next);
    return next;
  }
}

export async function get_user_settings(args: { user_id: string }, store: SettingsStoreLike) {
  return store.get(args.user_id);
}

export async function update_user_settings(
  args: { user_id: string; patch: Partial<UserSettings> },
  store: SettingsStoreLike,
) {
  return store.update(args.user_id, args.patch);
}
