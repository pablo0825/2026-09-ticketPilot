import { executionPlatform } from "./executionRegistry.js";
import type { RunCapabilities } from "../../shared/runControls.js";

// 每次回應依目前登記處產生，磁碟上的能力資訊不能授權操作。
export function runCapabilities(platform: string | null): RunCapabilities {
    if (platform === null) return { stop: false, participants: false };
    const definition = executionPlatform(platform);
    return { stop: !!definition.stop, participants: !!definition.participants };
}
