export type StepState = "done" | "running" | "pending" | "action" | "failed" | "stopped" | "unknown" | "skipped";

export interface RunStep {
    label: string;
    state: StepState;
    note?: string;
    participantsButton?: boolean;
}
