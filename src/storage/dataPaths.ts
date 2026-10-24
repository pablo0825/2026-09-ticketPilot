import { fileURLToPath } from "node:url";
import { join } from "node:path";

export const projectRoot = fileURLToPath(new URL("../../", import.meta.url));
export const localDataDirectory = join(projectRoot, "local-data");
export const activityDirectory = join(localDataDirectory, "events");
export const ticketPlusProfileDirectory = join(projectRoot, "browser-profile-ticketplus");
