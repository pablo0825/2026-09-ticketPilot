import type { RunStep } from "./runStep.js";

export type BadgeTone = "info" | "action" | "done" | "neutral" | "error" | "unknown";

export interface RunStepsView {
    title: string;
    badge: { text: string; tone: BadgeTone };
    summary: string;
    steps: RunStep[];
}
