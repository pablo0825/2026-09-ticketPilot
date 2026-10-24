import type { ActivitySettings } from "../config/activitySettings.js";

export interface ActivityRecord {
    schemaVersion: 3;
    id: string;
    updatedAt: string;
    settings: ActivitySettings;
}
