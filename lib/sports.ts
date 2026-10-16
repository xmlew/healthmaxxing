export const SPORTS = ["swim", "bike", "run"] as const;
export type Sport = (typeof SPORTS)[number];

export const SESSION_STATUSES = ["planned", "completed"] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

export type SessionKind = Sport | "brick";

// A brick is any session with more than one leg; a single leg is that sport.
export function sessionKind(segments: { sport: Sport }[]): SessionKind {
  return segments.length === 1 ? segments[0].sport : "brick";
}
