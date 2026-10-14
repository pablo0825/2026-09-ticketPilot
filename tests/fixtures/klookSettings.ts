import assert from "node:assert/strict";
import type { ActivitySettings, KlookActivitySettings } from "../../src/config/activityStore.js";

export function klookSettings(settings: ActivitySettings): KlookActivitySettings {
    assert.equal(settings.platform, "klook");
    return settings;
}
