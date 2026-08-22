import { JOB_STATES, type JobState } from "./types.js";
import { InvalidTransitionError } from "./errors.js";

const TRANSITIONS: Record<JobState, readonly JobState[]> = {
  queued: ["running", "scheduled", "cancelled"],
  scheduled: ["queued", "cancelled"],
  running: ["succeeded", "failed", "retrying", "dead", "queued"],
  retrying: ["queued", "cancelled"],
  succeeded: ["queued"],
  failed: ["queued", "dead"],
  dead: ["queued"],
  cancelled: [],
};

export function canTransition(from: JobState, to: JobState): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(jobId: string, from: JobState, to: JobState): void {
  if (!canTransition(from, to)) {
    throw new InvalidTransitionError(jobId, from, to);
  }
}

export function validTransitions(from: JobState): readonly JobState[] {
  return TRANSITIONS[from];
}

export function isJobState(value: unknown): value is JobState {
  return typeof value === "string" && (JOB_STATES as readonly string[]).includes(value);
}
