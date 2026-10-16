import { shiftDayKey } from "./time";

// How far ahead an expiry date counts as "expiring soon": a race-season box of
// gels is bought weeks ahead, and a month is enough lead time to use or replace.
export const EXPIRY_WARNING_DAYS = 30;

export type Lot = { servings: number; expiresOn: string | null };

export type ExpiryStatus = {
  expiredServings: number;
  expiringSoonServings: number;
  nextExpiry: string | null;
};

function earliestExpiryFirst(a: Lot, b: Lot): number {
  if (a.expiresOn === b.expiresOn) return 0;
  if (a.expiresOn == null) return 1;
  if (b.expiresOn == null) return -1;
  return a.expiresOn < b.expiresOn ? -1 : 1;
}

// Which lots are still on hand is not recorded, so it is inferred: servings
// leave earliest-expiry first (undated lots last), which is how a box of gels
// is actually used. Whatever remains is checked against today.
export function expiryOf(lots: Lot[], servingsUsed: number, today: string): ExpiryStatus {
  const ordered = [...lots].sort(earliestExpiryFirst);
  let toUse = servingsUsed;
  const soon = shiftDayKey(today, EXPIRY_WARNING_DAYS);
  const status: ExpiryStatus = { expiredServings: 0, expiringSoonServings: 0, nextExpiry: null };
  for (const lot of ordered) {
    const used = Math.min(lot.servings, Math.max(toUse, 0));
    toUse -= used;
    const remaining = lot.servings - used;
    if (remaining <= 0 || lot.expiresOn == null) continue;
    if (lot.expiresOn < today) status.expiredServings += remaining;
    else {
      if (lot.expiresOn <= soon) status.expiringSoonServings += remaining;
      status.nextExpiry ??= lot.expiresOn;
    }
  }
  return status;
}
