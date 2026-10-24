import type { ActivitySettings } from "../../config/activitySettings.js";
import { createExecutionRegistry } from "./platformDefinition.js";
import { ticketPlusDefinition } from "./ticketPlus.js";

export const executionPlatform = createExecutionRegistry([ticketPlusDefinition]);
export function platformFor(settings: ActivitySettings) {
    const definition = executionPlatform(settings.platform);
    return { definition, ...definition.bind(settings) };
}
