// Kept free of any database import so client components can use the vocabulary
// without pulling the postgres driver into the browser bundle.
//
// Only a working set counts toward 1RM estimates, progressive-overload PRs, and
// training volume: a heavy warm-up ahead of a lighter top set would otherwise
// read as the day's best effort, and a burnout set at half the load inflates
// volume without representing the weight actually handled. Non-working sets are
// still stored and shown - they just do not set records. See db/schema.sql.
export const SET_TYPES = ["working", "warmup", "dropset", "burnout"] as const;
export type SetType = (typeof SET_TYPES)[number];
export const WORKING_SET_TYPE: SetType = "working";

export const isWorkingSet = (set: { setType: SetType }): boolean => set.setType === WORKING_SET_TYPE;

export const SET_TYPE_LABELS: Record<SetType, string> = {
  working: "Working",
  warmup: "Warm-up",
  dropset: "Drop set",
  burnout: "Burnout",
};
