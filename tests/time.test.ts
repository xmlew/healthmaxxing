import { test } from "node:test";
import assert from "node:assert/strict";
import { formatDate, dayKeyInZone } from "../lib/time";

for (const hostZone of ["UTC", "America/Los_Angeles", "Asia/Singapore", "Pacific/Kiritimati"]) {
  test(`calendar and timestamp labels agree with app days on a ${hostZone} host`, () => {
    const previous = process.env.TZ;
    process.env.TZ = hostZone;
    try {
      for (const [day, label] of [
        ["2026-09-09", "Sep 9"],
        ["2026-01-01", "Jan 1"],
        ["2026-03-08", "Mar 8"],
        ["2026-11-01", "Nov 1"],
      ]) {
        assert.equal(formatDate(day), label);
      }
      for (const instant of ["2026-09-09T06:59:59Z", "2026-09-09T07:00:00Z", "2026-01-01T07:59:59Z", "2026-01-01T08:00:00Z"]) {
        assert.equal(formatDate(instant), formatDate(dayKeyInZone(new Date(instant))));
      }
      assert.equal(formatDate("2026-09-09T17:30:00Z", {
        month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
      }), "Sep 9, 10:30 AM");
    } finally {
      if (previous === undefined) delete process.env.TZ;
      else process.env.TZ = previous;
    }
  });
}
