// Single-user app: "today" is resolved against one fixed IANA zone rather than
// server local time, since deployed hosts (Vercel) run their clock in UTC.
// Matches the -07:00 offset seen in this user's Health Auto Export data.
export const TIME_ZONE = "America/Los_Angeles";

export const KJ_PER_KCAL = 4.184;

export function kjToKcal(kj: number): number {
  return kj / KJ_PER_KCAL;
}

const dayKeyFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

export function dayKeyInZone(date: Date): string {
  return dayKeyFormatter.format(date);
}
