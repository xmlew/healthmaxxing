import { sql } from "./db";
import { sessionKind, type SessionKind, type SessionStatus, type Sport } from "./sports";
import { insertSegments, type Db, type SegmentInput } from "./training-segments";

export type SegmentEquipment = { id: number; name: string };

export type TrainingSegment = {
  position: number;
  sport: Sport;
  durationMin: number | null;
  distanceKm: number | null;
  equipment: SegmentEquipment[];
};

export type FuelInput = { consumableId: number; servings: number };

export type SessionFuel = {
  name: string;
  servings: number;
  servingUnit: string;
  // For these servings; null when the product has no carb figure.
  carbsG: number | null;
};

export type TrainingSession = {
  id: number;
  date: string;
  status: SessionStatus;
  kind: SessionKind;
  source: "manual" | "imported";
  workoutId: string | null;
  rpe: number | null;
  notes: string | null;
  totalDurationMin: number | null;
  totalDistanceKm: number | null;
  deletedAt: string | null;
  segments: TrainingSegment[];
  fuel: SessionFuel[];
  // Only when every fuel line has a carb figure and the duration is known.
  carbsPerHour: number | null;
};

// A total is only reported when every segment supplied that measure: summing the
// legs that have one would present a partial figure as the whole session.
function totalOf(segments: TrainingSegment[], key: "durationMin" | "distanceKm"): number | null {
  if (segments.length === 0 || segments.some((s) => s[key] == null)) return null;
  return segments.reduce((sum, s) => sum + (s[key] as number), 0);
}

function toDateStr(value: unknown): string {
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value);
}

async function replaceFuel(db: Db, sessionId: number, fuel: FuelInput[]): Promise<void> {
  await db`delete from training_session_fuel where session_id = ${sessionId}`;
  if (fuel.length === 0) return;
  await db`
    insert into training_session_fuel ${db(
      fuel.map((f) => ({ session_id: sessionId, consumable_id: f.consumableId, servings: f.servings })),
    )}
  `;
}

export async function createTrainingSession(input: {
  sessionDate: string;
  status: SessionStatus;
  rpe: number | null;
  notes: string | null;
  segments: SegmentInput[];
  fuel: FuelInput[];
}): Promise<number> {
  return sql.begin(async (tx) => {
    const [row] = await tx`
      insert into training_sessions (session_date, status, rpe, notes)
      values (${input.sessionDate}::date, ${input.status}, ${input.rpe}, ${input.notes})
      returning id
    `;
    const id = Number(row.id);
    await insertSegments(tx, id, input.segments);
    await replaceFuel(tx, id, input.fuel);
    return id;
  });
}

// Fields left undefined keep their stored value. `segments`, when given,
// replaces the whole ordered list, and `fuel` the whole fuel list: each is
// edited as a unit, and replacing it is what keeps derived usage and stock
// exact after an edit.
export async function updateTrainingSession(
  id: number,
  patch: {
    sessionDate?: string;
    status?: SessionStatus;
    rpe?: number | null;
    notes?: string | null;
    segments?: SegmentInput[];
    fuel?: FuelInput[];
  },
): Promise<boolean> {
  return sql.begin(async (tx) => {
    const [existing] = await tx`
      select id from training_sessions where id = ${id} and deleted_at is null for update
    `;
    if (!existing) return false;
    await tx`
      update training_sessions set
        session_date = coalesce(${patch.sessionDate ?? null}::date, session_date),
        status = coalesce(${patch.status ?? null}, status),
        rpe = ${patch.rpe === undefined ? tx`rpe` : patch.rpe},
        notes = ${patch.notes === undefined ? tx`notes` : patch.notes},
        updated_at = now()
      where id = ${id}
    `;
    if (patch.segments) {
      await tx`delete from training_segments where session_id = ${id}`;
      await insertSegments(tx, id, patch.segments);
    }
    if (patch.fuel) await replaceFuel(tx, id, patch.fuel);
    return true;
  });
}

export async function setTrainingSessionDeleted(id: number, deleted: boolean): Promise<boolean> {
  const rows = deleted
    ? await sql`
        update training_sessions set deleted_at = now(), updated_at = now()
        where id = ${id} and deleted_at is null
        returning id
      `
    : await sql`
        update training_sessions set deleted_at = null, updated_at = now()
        where id = ${id} and deleted_at is not null
        returning id
      `;
  return rows.length > 0;
}

export async function listTrainingSessions(filter: {
  from?: string;
  to?: string;
  status?: SessionStatus;
  ids?: number[];
  includeDeleted?: boolean;
}): Promise<TrainingSession[]> {
  const sessions = await sql`
    select id, session_date, status, rpe, notes, workout_id, deleted_at
    from training_sessions
    where true
      ${filter.from ? sql`and session_date >= ${filter.from}::date` : sql``}
      ${filter.to ? sql`and session_date <= ${filter.to}::date` : sql``}
      ${filter.status ? sql`and status = ${filter.status}` : sql``}
      ${filter.ids ? sql`and id = any(${filter.ids})` : sql``}
      ${filter.includeDeleted ? sql`` : sql`and deleted_at is null`}
    order by session_date desc, id desc
  `;
  if (sessions.length === 0) return [];

  const sessionIds = sessions.map((s) => Number(s.id));
  const segments = await sql`
    select
      seg.id, seg.session_id, seg.position, seg.sport, seg.duration_min, seg.distance_km,
      coalesce(
        json_agg(json_build_object('id', e.id, 'name', e.name) order by e.name)
          filter (where e.id is not null),
        '[]'
      ) as equipment
    from training_segments seg
    left join training_segment_equipment tse on tse.segment_id = seg.id
    left join equipment e on e.id = tse.equipment_id
    where seg.session_id = any(${sessionIds})
    group by seg.id
    order by seg.session_id, seg.position
  `;

  const fuelRows = await sql`
    select f.session_id, c.name, f.servings, c.serving_unit, c.carbs_g
    from training_session_fuel f
    join consumables c on c.id = f.consumable_id
    where f.session_id = any(${sessionIds})
    order by c.name
  `;
  const fuelBySession = new Map<number, SessionFuel[]>();
  for (const f of fuelRows) {
    const list = fuelBySession.get(Number(f.session_id)) ?? [];
    list.push({
      name: f.name as string,
      servings: Number(f.servings),
      servingUnit: f.serving_unit as string,
      carbsG: f.carbs_g == null ? null : Number(f.carbs_g) * Number(f.servings),
    });
    fuelBySession.set(Number(f.session_id), list);
  }

  const bySession = new Map<number, TrainingSegment[]>();
  for (const s of segments) {
    const list = bySession.get(Number(s.session_id)) ?? [];
    list.push({
      position: Number(s.position),
      sport: s.sport as Sport,
      durationMin: s.duration_min == null ? null : Number(s.duration_min),
      distanceKm: s.distance_km == null ? null : Number(s.distance_km),
      equipment: (s.equipment as { id: number | string; name: string }[]).map((e) => ({
        id: Number(e.id),
        name: e.name,
      })),
    });
    bySession.set(Number(s.session_id), list);
  }

  return sessions.map((s) => {
    const segs = bySession.get(Number(s.id)) ?? [];
    const fuel = fuelBySession.get(Number(s.id)) ?? [];
    const totalDurationMin = totalOf(segs, "durationMin");
    const totalCarbsG = fuel.every((f) => f.carbsG != null)
      ? fuel.reduce((sum, f) => sum + (f.carbsG as number), 0)
      : null;
    return {
      id: Number(s.id),
      date: toDateStr(s.session_date),
      status: s.status as SessionStatus,
      kind: sessionKind(segs),
      source: s.workout_id ? "imported" : "manual",
      workoutId: (s.workout_id as string | null) ?? null,
      rpe: s.rpe == null ? null : Number(s.rpe),
      notes: (s.notes as string | null) ?? null,
      totalDurationMin,
      totalDistanceKm: totalOf(segs, "distanceKm"),
      deletedAt: s.deleted_at ? (s.deleted_at as Date).toISOString() : null,
      segments: segs,
      fuel,
      carbsPerHour:
        fuel.length > 0 && totalCarbsG != null && totalDurationMin != null
          ? totalCarbsG / (totalDurationMin / 60)
          : null,
    };
  });
}

export async function getTrainingSession(
  id: number,
  { includeDeleted = false }: { includeDeleted?: boolean } = {},
): Promise<TrainingSession | null> {
  const [session] = await listTrainingSessions({ ids: [id], includeDeleted });
  return session ?? null;
}
