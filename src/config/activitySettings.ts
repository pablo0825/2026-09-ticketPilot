import type { TicketPlusActivitySettings } from "./platforms/ticketplus/activitySettings.js";
import { ArchivedKlookActivityError } from "./archivedKlookActivity.js";
import { parsePlatformSettings } from "./settingsRegistry.js";

export type ActivitySettings = TicketPlusActivitySettings;

export function parseActivity(value: unknown): ActivitySettings {
    if (value && typeof value === "object" && "platform" in value && value.platform === "klook") {
        throw new ArchivedKlookActivityError();
    }

    return parsePlatformSettings(value);
}
