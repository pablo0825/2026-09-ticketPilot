import type { TicketPlusActivitySettings } from "./ticketPlusActivity.js";
import { ArchivedKlookActivityError } from "./archivedKlookActivity.js";
import { parsePlatformSettings } from "./platforms.js";

export type ActivitySettings = TicketPlusActivitySettings;

export function parseActivity(value: unknown): ActivitySettings {
    if (value && typeof value === "object" && "platform" in value && value.platform === "klook") {
        throw new ArchivedKlookActivityError();
    }
    return parsePlatformSettings(value);
}
