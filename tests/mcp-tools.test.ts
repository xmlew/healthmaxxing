import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mcpClient } from "./support/mcp";
import { startTestServer, type TestServer } from "./support/server";
import { selectTestDatabase } from "./support/test-db";
import postgres from "postgres";

selectTestDatabase();

const PORT = 3130;
const BASE = `http://localhost:${PORT}`;
const SECRET = process.env.MCP_SECRET;

// Sentinel exercises the strength tests write; cleaned up in after().
const STRENGTH_TEST_EXERCISE = "__mcp_test_lift__";
const WORKOUT_TEST_EXERCISE = "__mcp_test_press__";
const WORKOUT_TEST_ACCESSORY = "__mcp_test_raise__";
const ROUTINE_TEST_LIFT = "__mcp_test_routine_lift__";
const TEST_EXERCISES = [
  STRENGTH_TEST_EXERCISE,
  WORKOUT_TEST_EXERCISE,
  WORKOUT_TEST_ACCESSORY,
  ROUTINE_TEST_LIFT,
  "__mcp_calendar_lift__",
];
// Built and torn down by the routine test. Never the real routine: these tools
// write, and the dev DB holds the actual training plan.
const TEST_ROUTINE = "__mcp_test_routine__";
let strengthTestSessionId: number | null = null;
const workoutTestSessionIds: number[] = [];

// log_workout back-dates its sessions so PR comparison spans real days.
function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

async function withSql<T>(fn: (sql: postgres.Sql) => Promise<T>): Promise<T> {
  const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
  try {
    return await fn(sql);
  } finally {
    await sql.end();
  }
}

let server: TestServer | undefined;
const { rpc, callTool } = mcpClient(BASE, SECRET);

before(async () => {
  assert.ok(SECRET, "MCP_SECRET must be set in .env.local for the test");
  await removeSentinels();
  server = await startTestServer(PORT);
});

after(() => {
  server?.stop();
});

// Remove every sentinel row these tests write, by exact match, so the shared dev
// DB is left as it was found. Runs before the suite as well as after it: a run
// that dies mid-way would otherwise poison the next one with leftover sets.
async function removeSentinels(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) return;
  await withSql(async (sql) => {
    // The sentinel routine cascades to its days and targets; drop it before the
    // exercises those targets reference.
    await sql`delete from routines where name = ${TEST_ROUTINE}`;
    await sql`delete from strength_sets where exercise_id in (select id from exercises where name = any(${TEST_EXERCISES}))`;
    await sql`delete from exercises where name = any(${TEST_EXERCISES})`;
    // Sessions are matched by id, and only when now empty - never other empty
    // manual sessions on the shared DB. A crashed run can leave one behind; it
    // holds no sets, and the next run's ids will not collide with it.
    const sessionIds = [strengthTestSessionId, ...workoutTestSessionIds].filter(
      (id): id is number => id != null,
    );
    if (sessionIds.length > 0) {
      await sql`
        delete from strength_sessions
        where id = any(${sessionIds})
          and workout_id is null
          and id not in (select session_id from strength_sets)
      `;
    }
  });
}

after(removeSentinels);

test("tools/list exposes the four new analysis tools", async () => {
  const { body } = await rpc("tools/list", {});
  const tools = body.result?.tools ?? [];
  const names = tools.map((t) => t.name);
  for (const expected of ["get_recovery", "get_tdee", "get_correlation", "get_anomalies"]) {
    assert.ok(names.includes(expected), `tools/list missing ${expected}; got ${names.join(", ")}`);
  }
  assert.equal(tools.length, 40, "expected 40 tools total (25 prior + 5 training session + 2 equipment + 3 fuel + 5 maintenance tools)");
});

test("get_macro_summary returns per-day macros and targets", async () => {
  const data = await callTool("get_macro_summary", { days: 7 });
  assert.equal(data.days, 7);
  assert.ok("proteinTargetG" in data, "proteinTargetG present");
  assert.ok("calorieTarget" in data, "calorieTarget present");
  assert.ok(Array.isArray(data.series), "series is an array");
});

test("strength tools are registered and round-trip a logged set", async () => {
  const { body } = await rpc("tools/list", {});
  const names = (body.result?.tools ?? []).map((t) => t.name);
  for (const expected of ["log_set", "get_exercise_history", "get_1rm_estimate"]) {
    assert.ok(names.includes(expected), `tools/list missing ${expected}`);
  }

  const logged = await callTool<{ ok: boolean; setId: number; sessionId: number; estimated1RMLb: number }>("log_set", {
    exercise: STRENGTH_TEST_EXERCISE,
    reps: 5,
    weight_lb: 100,
    muscle_group: "push",
  });
  assert.equal(logged.ok, true, "log_set should succeed");
  assert.ok(logged.setId, "log_set returns a setId");
  strengthTestSessionId = logged.sessionId;
  // Epley: 100 * (1 + 5/30) = 116.7
  assert.equal(logged.estimated1RMLb, 116.7, "log_set echoes the estimated 1RM");

  const history = await callTool<{
    sessions: { volumeLb: number; sets: { setId: number; weightLb: number }[] }[];
  }>("get_exercise_history", { exercise: STRENGTH_TEST_EXERCISE });
  assert.ok(Array.isArray(history.sessions) && history.sessions.length >= 1, "history has a session");
  // Logged in pounds, stored in kilograms, read back in pounds without drift.
  assert.equal(history.sessions[0].sets[0].weightLb, 100, "weight round-trips through kg storage");
  assert.equal(history.sessions[0].volumeLb, 500, "session volume is weight*reps (100*5)");
  assert.ok(history.sessions[0].sets[0].setId, "each set carries a setId");

  const oneRm = await callTool("get_1rm_estimate", { exercise: STRENGTH_TEST_EXERCISE, formula: "brzycki" });
  // Brzycki: 100 * 36/(37-5) = 112.5
  assert.equal(oneRm.currentLb, 112.5, "get_1rm_estimate uses the requested formula");

  const overload = await callTool("get_progressive_overload_status", { exercise: STRENGTH_TEST_EXERCISE });
  assert.ok("stalled" in overload, "overload status has a stalled flag");
  assert.ok(Array.isArray(overload.sessions), "overload status has a sessions array");
  assert.equal(overload.latestSessionVolumeLb, 500, "latest session volume is 100*5");

  const exercises = await callTool<Array<{ name: string }>>("list_exercises");
  assert.ok(exercises.some((e) => e.name === STRENGTH_TEST_EXERCISE), "list_exercises includes the logged exercise");

  // delete_set removes the logged set (done last so the assertions above still see it)
  const del = await callTool<{ ok: boolean }>("delete_set", { id: String(history.sessions[0].sets[0].setId) });
  assert.equal(del.ok, true, "delete_set removes the set");
});

test("non-working sets are recorded but excluded from volume and 1RM", async () => {
  // Warm-up deliberately heavier than the working set: if it leaked into the
  // derived numbers it would dominate both of them.
  //
  // The previous test's session was tidied away when its last set was deleted,
  // so these open a new one - track it, or teardown leaves it behind.
  const opened = await callTool<{ sessionId: number }>("log_set", {
    exercise: STRENGTH_TEST_EXERCISE,
    reps: 5,
    weight_lb: 200,
    type: "warmup",
    muscle_group: "push",
  });
  workoutTestSessionIds.push(opened.sessionId);
  await callTool("log_set", {
    exercise: STRENGTH_TEST_EXERCISE,
    reps: 5,
    weight_lb: 100,
    muscle_group: "push",
  });

  const history = await callTool<{
    sessions: { volumeLb: number; sets: { setType: string; estimated1RMLb: number | null }[] }[];
  }>("get_exercise_history", { exercise: STRENGTH_TEST_EXERCISE });
  const session = history.sessions[history.sessions.length - 1];

  assert.equal(session.sets.length, 2, "both sets are listed");
  const warmup = session.sets.find((s) => s.setType === "warmup");
  assert.ok(warmup, "the warm-up is still recorded");
  assert.equal(warmup.estimated1RMLb, null, "a warm-up carries no 1RM estimate");
  assert.equal(session.volumeLb, 500, "volume counts the working set only (100*5)");

  const oneRm = await callTool<{ currentLb: number }>("get_1rm_estimate", {
    exercise: STRENGTH_TEST_EXERCISE,
  });
  // Epley on the 100 lb working set, not the 200 lb warm-up (which would be 233.3).
  assert.equal(oneRm.currentLb, 116.7, "1RM comes from the working set");
});

test("log_workout records a whole session in one call", async () => {
  const logged = await callTool<{
    ok: boolean;
    sessionId: number;
    setsLogged: number;
    exercises: {
      exercise: string;
      setsLogged: number;
      workingVolumeLb: number;
      topSetLb: number | null;
      estimated1RMLb: number | null;
      previousBestEstimated1RMLb: number | null;
      newPr: boolean;
    }[];
  }>("log_workout", {
    date: daysAgoIso(9),
    exercises: [
      {
        name: WORKOUT_TEST_EXERCISE,
        muscle_group: "push",
        sets: [
          { reps: 12, weight_lb: 95, type: "warmup" },
          { reps: 8, weight_lb: 135 },
          { reps: 8, weight_lb: 135 },
        ],
      },
      {
        name: WORKOUT_TEST_ACCESSORY,
        muscle_group: "push",
        sets: [{ reps: 10, weight_lb: 40 }],
      },
    ],
    notes: "mcp round-trip",
  });

  assert.equal(logged.ok, true, "log_workout should succeed");
  workoutTestSessionIds.push(logged.sessionId);
  assert.equal(logged.setsLogged, 4, "every set across both exercises is written");
  assert.equal(logged.exercises.length, 2, "each exercise is summarized");

  const [first, second] = logged.exercises;
  assert.equal(first.setsLogged, 3, "the warm-up is logged alongside the working sets");
  assert.equal(first.workingVolumeLb, 2160, "working volume excludes the warm-up (135*8*2)");
  assert.equal(first.topSetLb, 135, "top set is the heaviest working set");
  assert.equal(second.workingVolumeLb, 400, "the second exercise is summarized independently");
  assert.equal(first.previousBestEstimated1RMLb, null, "a brand new exercise has no previous best");
  assert.equal(first.newPr, true, "a first-ever set counts as a PR");

  // A later session is judged against the earlier one, not against itself.
  const heavier = await callTool<{
    sessionId: number;
    exercises: { previousBestEstimated1RMLb: number | null; newPr: boolean }[];
  }>("log_workout", {
    date: daysAgoIso(2),
    exercises: [
      { name: WORKOUT_TEST_EXERCISE, sets: [{ reps: 8, weight_lb: 145 }] },
    ],
  });
  workoutTestSessionIds.push(heavier.sessionId);
  // Epley on the earlier top set: 135 * (1 + 8/30) = 171.
  assert.equal(
    heavier.exercises[0].previousBestEstimated1RMLb,
    171,
    "previous best comes from the earlier session",
  );
  assert.equal(heavier.exercises[0].newPr, true, "145 x 8 beats it");

  // Back-dating between the two must not credit the session that came after.
  const backdated = await callTool<{
    sessionId: number;
    exercises: { previousBestEstimated1RMLb: number | null }[];
  }>("log_workout", {
    date: daysAgoIso(5),
    exercises: [
      { name: WORKOUT_TEST_EXERCISE, sets: [{ reps: 8, weight_lb: 140 }] },
    ],
  });
  workoutTestSessionIds.push(backdated.sessionId);
  assert.equal(
    backdated.exercises[0].previousBestEstimated1RMLb,
    171,
    "a back-dated session only sees sessions before it",
  );
});

test("get_routine plans a day and advances the rotation", async () => {
  await withSql(async (sql) => {
    const [routine] = await sql`
      insert into routines (name) values (${TEST_ROUTINE}) returning id
    `;
    const [exercise] = await sql`
      insert into exercises (name, muscle_group) values (${ROUTINE_TEST_LIFT}, 'push') returning id
    `;
    for (const [i, name] of ["testpush", "testpull"].entries()) {
      const [day] = await sql`
        insert into routine_days (routine_id, name, position)
        values (${routine.id}, ${name}, ${i + 1})
        returning id
      `;
      await sql`
        insert into routine_exercises
          (day_id, exercise_id, position, target_sets, target_reps, target_weight_kg)
        values (${day.id}, ${exercise.id}, 1, 3, 8, ${100 / 2.20462262185})
      `;
    }
  });

  const first = await callTool<{
    day: string;
    dayChosenBy: string;
    lastTrained: string | null;
    exercises: {
      exercise: string;
      targetSets: number;
      targetReps: number;
      targetWeightLb: number;
      lastSession: unknown;
      suggestion: { status: string; suggestedWeightLb: number | null };
    }[];
  }>("get_routine", { routine: TEST_ROUTINE });

  assert.equal(first.day, "testpush", "with nothing logged, the rotation starts at the first day");
  assert.equal(first.dayChosenBy, "next in rotation");
  assert.equal(first.lastTrained, null, "the day has never been trained");
  assert.equal(first.exercises[0].targetWeightLb, 100, "targets are reported in pounds");
  assert.equal(first.exercises[0].lastSession, null, "no history yet");
  assert.equal(first.exercises[0].suggestion.status, "no_history");

  // Meeting the target on every working set earns the increment.
  const workout = await callTool<{ day: string; sessionId: number }>("log_workout", {
    routine: TEST_ROUTINE,
    day: "testpush",
    date: daysAgoIso(3),
    exercises: [
      {
        name: ROUTINE_TEST_LIFT,
        sets: [
          { reps: 12, weight_lb: 70, type: "warmup" },
          { reps: 8, weight_lb: 100 },
          { reps: 8, weight_lb: 100 },
          { reps: 8, weight_lb: 100 },
        ],
      },
    ],
  });
  assert.equal(workout.day, "testpush", "the session is tagged with the routine day");
  workoutTestSessionIds.push(workout.sessionId);

  const next = await callTool<{ day: string }>("get_routine", { routine: TEST_ROUTINE });
  assert.equal(next.day, "testpull", "the rotation advances past the day just trained");

  const trained = await callTool<{
    lastTrained: string | null;
    exercises: {
      lastSession: { sets: { weightLb: number; setType: string }[] } | null;
      suggestion: { status: string; suggestedWeightLb: number | null; reason: string };
    }[];
  }>("get_routine", { routine: TEST_ROUTINE, day: "testpush" });

  assert.ok(trained.lastTrained, "the trained day reports when it was last done");
  assert.equal(trained.exercises[0].lastSession?.sets.length, 4, "last session shows every set");
  assert.equal(
    trained.exercises[0].suggestion.status,
    "advance",
    "hitting 3x8 at the target earns an increase",
  );
  assert.equal(
    trained.exercises[0].suggestion.suggestedWeightLb,
    105,
    "the suggestion is one 5 lb increment up",
  );

  // A session short of the target repeats it instead.
  const shortfall = await callTool<{ sessionId: number }>("log_workout", {
    routine: TEST_ROUTINE,
    day: "testpush",
    date: daysAgoIso(1),
    exercises: [
      { name: ROUTINE_TEST_LIFT, sets: [{ reps: 5, weight_lb: 100 }, { reps: 5, weight_lb: 100 }] },
    ],
  });
  workoutTestSessionIds.push(shortfall.sessionId);

  const held = await callTool<{
    exercises: { suggestion: { status: string; suggestedWeightLb: number | null } }[];
  }>("get_routine", { routine: TEST_ROUTINE, day: "testpush" });
  assert.equal(held.exercises[0].suggestion.status, "repeat", "a missed target is not advanced");
  assert.equal(held.exercises[0].suggestion.suggestedWeightLb, 100, "it repeats the same weight");

  // set_routine_target changes only what it is given.
  const updated = await callTool<{
    targetWeightLb: number;
    targetSets: number;
    targetReps: number;
  }>("set_routine_target", {
    routine: TEST_ROUTINE,
    day: "testpush",
    exercise: ROUTINE_TEST_LIFT,
    target_weight_lb: 110,
  });
  assert.equal(updated.targetWeightLb, 110, "the weight target moves");
  assert.equal(updated.targetSets, 3, "sets are untouched");
  assert.equal(updated.targetReps, 8, "reps are untouched");

  const unknownDay = await rpc("tools/call", {
    name: "get_routine",
    arguments: { routine: TEST_ROUTINE, day: "nosuchday" },
  });
  assert.ok(
    unknownDay.body.result?.isError,
    "an unknown day is an error, not a silently empty plan",
  );
});

test("get_recovery returns a recovery analysis shape", async () => {
  const data = await callTool<{ days: number; series: unknown[]; flag: { status: string } }>("get_recovery", {
    days: 30,
  });
  assert.equal(data.days, 30);
  assert.ok(Array.isArray(data.series), "series should be an array");
  assert.ok(data.flag && typeof data.flag.status === "string", "flag.status should be present");
  assert.ok(
    ["warning", "steady", "insufficient_data"].includes(data.flag.status),
    `unexpected flag.status: ${data.flag?.status}`,
  );
});

test("get_tdee returns a TDEE analysis shape", async () => {
  const data = await callTool("get_tdee", { days: 30 });
  assert.ok(Array.isArray(data.days), "days should be an array of TdeeDay");
  assert.ok("rollingWindow" in data, "rollingWindow should be present");
  assert.ok("rollingTdee" in data, "rollingTdee should be present");
  assert.ok("impliedWeightChangeKg" in data, "impliedWeightChangeKg should be present");
});

test("get_correlation returns a correlation result for a valid pairing", async () => {
  const data = await callTool<{ n: number; status: string; pairing: { key: string } }>("get_correlation", {
    pairing: "steps-vs-weight-loss-rate",
    days: 90,
  });
  assert.ok("n" in data, "n should be present");
  assert.ok("status" in data, "status should be present");
  assert.ok(data.pairing && data.pairing.key === "steps-vs-weight-loss-rate", "pairing echoed");
});

test("get_correlation rejects an unknown pairing", async () => {
  const { body } = await rpc("tools/call", {
    name: "get_correlation",
    arguments: { pairing: "not-a-real-pairing", days: 30 },
  });
  // zod enum rejection surfaces as a JSON-RPC error or an isError tool result.
  const isError =
    body?.error != null || body?.result?.isError === true;
  assert.ok(isError, `expected an error for unknown pairing, got: ${JSON.stringify(body).slice(0, 300)}`);
});

test("get_anomalies returns every evaluated signal with a status", async () => {
  const data = await callTool<Array<{ key: string; status: string }>>("get_anomalies");
  assert.ok(Array.isArray(data), "get_anomalies should return an array");
  for (const signal of data) {
    assert.ok(typeof signal.key === "string", "each signal has a key");
    assert.ok(typeof signal.status === "string", "each signal has a status");
  }
});

test("unauthenticated requests are rejected with 401", async () => {
  const { status } = await rpc("tools/list", {}, { auth: false });
  assert.equal(status, 401);
});

test("MCP calendar dates stay on the requested Los Angeles day", async () => {
  const cases = [
    ["2026-01-15", "2026-01-15T08:00:00.000Z"],
    ["2026-07-15", "2026-07-15T07:00:00.000Z"],
    ["2026-03-08", "2026-03-08T08:00:00.000Z"],
    ["2026-11-01", "2026-11-01T07:00:00.000Z"],
    ["2026-07-15T23:30:00", "2026-07-16T06:30:00.000Z"],
    ["2026-07-15T23:30:00-07:00", "2026-07-16T06:30:00.000Z"],
  ];
  try {
    for (const [date, expected] of cases) {
      for (const name of ["log_food", "log_weight"]) {
        const args = name === "log_food"
          ? { description: "__mcp_calendar_test__", calories: 123, date }
          : { kg: 70, note: "__mcp_calendar_test__", date };
        if (name === "log_weight") {
          await withSql(async (sql) => {
            const existing = await sql`select id from weight_logs where logged_at = ${expected}::timestamptz and source = 'manual' and note is distinct from '__mcp_calendar_test__'`;
            assert.equal(existing.length, 0, "refuse to overwrite an existing weigh-in");
          });
        }
        const logged = await callTool<{ loggedAt: string }>(name, args);
        assert.equal(logged.loggedAt, expected, `${name} resolves ${date}`);
        await withSql(async (sql) => {
          const rows = name === "log_food"
            ? await sql`select logged_at from food_logs where description = '__mcp_calendar_test__' order by id desc limit 1`
            : await sql`select logged_at from weight_logs where note = '__mcp_calendar_test__' and logged_at = ${expected}::timestamptz`;
          assert.equal(rows[0].logged_at.toISOString(), expected);
        });
      }
    }
  } finally {
    await withSql(async (sql) => {
      await sql`delete from food_logs where description = '__mcp_calendar_test__'`;
      await sql`delete from weight_logs where note = '__mcp_calendar_test__'`;
    });
  }
});

test("MCP rejects invalid calendar dates without writing", async () => {
  for (const date of ["2026-02-30", "2026-13-01", "not-a-date"]) {
    const { body } = await rpc("tools/call", {
      name: "log_food", arguments: { description: "__mcp_invalid_date_test__", calories: 1, date },
    });
    try {
      assert.equal(body.result?.isError, true, date);
      await withSql(async (sql) => {
        const rows = await sql`select id from food_logs where description = '__mcp_invalid_date_test__'`;
        assert.equal(rows.length, 0);
      });
    } finally {
      await withSql(async (sql) => {
        await sql`delete from food_logs where description = '__mcp_invalid_date_test__'`;
      });
    }
  }
});


test("date-only strength logging keeps sets and workouts on the requested day", async () => {
  const date = "2026-07-15";
  for (const name of ["log_set", "log_workout"]) {
    const args = name === "log_set"
      ? { date, exercise: "__mcp_calendar_lift__", reps: 5, weight_lb: 100 }
      : { date, exercises: [{ name: "__mcp_calendar_lift__", sets: [{ reps: 5, weight_lb: 100 }] }] };
    const logged = await callTool<{ sessionDate: string; sessionId: number }>(name, args);
    workoutTestSessionIds.push(logged.sessionId);
    assert.equal(logged.sessionDate, date, name);
    await withSql(async (sql) => {
      const [session] = await sql`select session_date::text as day from strength_sessions where id = ${logged.sessionId}`;
      assert.equal(session.day, date);
    });
  }
});
