import { test } from "node:test";
import assert from "node:assert/strict";
import { expiryOf } from "../lib/fuel-expiry";

const TODAY = "2026-10-16";

test("servings used come out of the earliest-expiring lots first", () => {
  const lots = [
    { servings: 4, expiresOn: "2027-06-01" },
    { servings: 6, expiresOn: "2026-10-01" },
  ];
  assert.deepEqual(expiryOf(lots, 0, TODAY), {
    expiredServings: 6,
    expiringSoonServings: 0,
    nextExpiry: "2027-06-01",
  });
  assert.deepEqual(expiryOf(lots, 6, TODAY), {
    expiredServings: 0,
    expiringSoonServings: 0,
    nextExpiry: "2027-06-01",
  }, "using six servings clears the expired lot, not the fresh one");
});

test("undated lots are used last and never count as expiring", () => {
  const lots = [
    { servings: 5, expiresOn: null },
    { servings: 3, expiresOn: "2026-11-01" },
  ];
  assert.deepEqual(expiryOf(lots, 2, TODAY), {
    expiredServings: 0,
    expiringSoonServings: 1,
    nextExpiry: "2026-11-01",
  });
  assert.deepEqual(expiryOf(lots, 7, TODAY), {
    expiredServings: 0,
    expiringSoonServings: 0,
    nextExpiry: null,
  });
});
