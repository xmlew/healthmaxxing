import { sql } from "./db";
import { daysBetween } from "./time";

// "Approaching" from this share of any interval, so a check can be planned
// before the ride that crosses it rather than noticed after.
export const APPROACHING_FRACTION = 0.9;

export type MaintenanceState = "ok" | "approaching" | "due";

export type MaintenanceRule = {
  id: number;
  equipmentId: number;
  equipment: string;
  name: string;
  intervalDays: number | null;
  intervalKm: number | null;
  intervalHours: number | null;
  startsOn: string;
  notes: string | null;
  lastServicedOn: string | null;
  // Usage is counted from sessions dated after this day: the order of a service
  // and a ride on the same day is not recorded, so the ride counts toward the
  // interval that was running when the day began.
  since: string;
  daysSince: number;
  kmSince: number;
  hoursSince: number;
  legsWithoutDistance: number;
  state: MaintenanceState;
  reasons: string[];
};

export type RuleIntervals = {
  intervalDays?: number | null;
  intervalKm?: number | null;
  intervalHours?: number | null;
};

const round1 = (n: number) => Math.round(n * 10) / 10;

function evaluate(
  rule: { intervalDays: number | null; intervalKm: number | null; intervalHours: number | null },
  used: { days: number; km: number; hours: number },
): { state: MaintenanceState; reasons: string[] } {
  const measures = [
    { interval: rule.intervalDays, used: used.days, label: (n: number) => `${n} days` },
    { interval: rule.intervalKm, used: used.km, label: (n: number) => `${round1(n)} km` },
    { interval: rule.intervalHours, used: used.hours, label: (n: number) => `${round1(n)} h` },
  ].filter((m): m is typeof m & { interval: number } => m.interval != null);

  const fractions = measures.map((m) => m.used / m.interval);
  const worst = Math.max(...fractions);
  const state: MaintenanceState = worst >= 1 ? "due" : worst >= APPROACHING_FRACTION ? "approaching" : "ok";
  return {
    state,
    reasons: measures.map((m) => `${m.label(m.used)} of every ${m.label(m.interval)}`),
  };
}

export async function listMaintenance(
  today: string,
  filter: { equipmentId?: number } = {},
): Promise<MaintenanceRule[]> {
  const rows = await sql`
    with rules as (
      select
        r.*, e.name as equipment_name,
        (
          select max(l.performed_on) from service_logs l
          where l.rule_id = r.id and l.deleted_at is null
        ) as last_serviced_on
      from maintenance_rules r
      join equipment e on e.id = r.equipment_id
      where e.status <> 'retired'
        ${filter.equipmentId ? sql`and r.equipment_id = ${filter.equipmentId}` : sql``}
    )
    select
      r.id, r.equipment_id, r.equipment_name, r.name, r.interval_days, r.interval_km,
      r.interval_hours, r.notes,
      to_char(r.starts_on, 'YYYY-MM-DD') as starts_on,
      to_char(r.last_serviced_on, 'YYYY-MM-DD') as last_serviced_on,
      to_char(coalesce(r.last_serviced_on, r.starts_on), 'YYYY-MM-DD') as since,
      coalesce(sum(seg.distance_km) filter (where ts.id is not null), 0) as km_since,
      coalesce(sum(seg.duration_min) filter (where ts.id is not null), 0) as minutes_since,
      count(seg.id) filter (where ts.id is not null and seg.distance_km is null) as legs_without_distance
    from rules r
    left join training_segment_equipment tse on tse.equipment_id = r.equipment_id
    left join training_segments seg on seg.id = tse.segment_id
    left join training_sessions ts
      on ts.id = seg.session_id
      and ts.status = 'completed'
      and ts.deleted_at is null
      and ts.session_date > coalesce(r.last_serviced_on, r.starts_on)
    group by r.id, r.equipment_id, r.equipment_name, r.name, r.interval_days, r.interval_km,
      r.interval_hours, r.notes, r.starts_on, r.last_serviced_on
    order by r.equipment_name, r.name
  `;
  return rows.map((r) => {
    const intervals = {
      intervalDays: r.interval_days == null ? null : Number(r.interval_days),
      intervalKm: r.interval_km == null ? null : Number(r.interval_km),
      intervalHours: r.interval_hours == null ? null : Number(r.interval_hours),
    };
    const since = r.since as string;
    const used = {
      days: Math.max(0, daysBetween(since, today)),
      km: Number(r.km_since),
      hours: Number(r.minutes_since) / 60,
    };
    return {
      id: Number(r.id),
      equipmentId: Number(r.equipment_id),
      equipment: r.equipment_name as string,
      name: r.name as string,
      ...intervals,
      startsOn: r.starts_on as string,
      notes: (r.notes as string | null) ?? null,
      lastServicedOn: (r.last_serviced_on as string | null) ?? null,
      since,
      daysSince: used.days,
      kmSince: used.km,
      hoursSince: used.hours,
      legsWithoutDistance: Number(r.legs_without_distance),
      ...evaluate(intervals, used),
    };
  });
}

export async function findEquipmentId(name: string): Promise<number | null> {
  const [row] = await sql`select id from equipment where lower(name) = lower(${name.trim()})`;
  return row ? Number(row.id) : null;
}

export async function findRuleId(equipmentId: number, name: string): Promise<number | null> {
  const [row] = await sql`
    select id from maintenance_rules
    where equipment_id = ${equipmentId} and lower(name) = lower(${name.trim()})
  `;
  return row ? Number(row.id) : null;
}

// Upserts by (item, rule name). An interval left undefined keeps its value and
// null clears it; the table refuses a rule left with no interval at all.
export async function setMaintenanceRule(
  equipmentId: number,
  name: string,
  patch: RuleIntervals & { startsOn?: string; notes?: string | null },
): Promise<{ id: number; created: boolean } | { error: string }> {
  const existingId = await findRuleId(equipmentId, name);
  try {
    if (existingId == null) {
      const [row] = await sql`
        insert into maintenance_rules
          (equipment_id, name, interval_days, interval_km, interval_hours, starts_on, notes)
        values (
          ${equipmentId}, ${name.trim()}, ${patch.intervalDays ?? null}, ${patch.intervalKm ?? null},
          ${patch.intervalHours ?? null}, coalesce(${patch.startsOn ?? null}::date, current_date),
          ${patch.notes ?? null}
        )
        returning id
      `;
      return { id: Number(row.id), created: true };
    }
    const keep = (value: unknown, column: string) =>
      value === undefined ? sql(column) : sql`${value as string | number | null}`;
    await sql`
      update maintenance_rules set
        interval_days = ${keep(patch.intervalDays, "interval_days")},
        interval_km = ${keep(patch.intervalKm, "interval_km")},
        interval_hours = ${keep(patch.intervalHours, "interval_hours")},
        starts_on = coalesce(${patch.startsOn ?? null}::date, starts_on),
        notes = ${keep(patch.notes, "notes")},
        updated_at = now()
      where id = ${existingId}
    `;
    return { id: existingId, created: false };
  } catch (err) {
    if ((err as { constraint_name?: string }).constraint_name === "maintenance_rules_interval_check") {
      return { error: "A rule needs at least one of every_days, every_km, or every_hours." };
    }
    throw err;
  }
}

export async function deleteMaintenanceRule(ruleId: number): Promise<void> {
  await sql`delete from maintenance_rules where id = ${ruleId}`;
}

export async function logService(input: {
  equipmentId: number;
  ruleId: number | null;
  performedOn: string;
  notes: string | null;
}): Promise<number> {
  const [row] = await sql`
    insert into service_logs (equipment_id, rule_id, performed_on, notes)
    values (${input.equipmentId}, ${input.ruleId}, ${input.performedOn}::date, ${input.notes})
    returning id
  `;
  return Number(row.id);
}

export async function setServiceLogDeleted(id: number, deleted: boolean): Promise<boolean> {
  const rows = deleted
    ? await sql`update service_logs set deleted_at = now() where id = ${id} and deleted_at is null returning id`
    : await sql`update service_logs set deleted_at = null where id = ${id} and deleted_at is not null returning id`;
  return rows.length > 0;
}

export type ServiceLog = {
  id: number;
  equipment: string;
  rule: string | null;
  performedOn: string;
  notes: string | null;
};

export async function listServiceLogs(filter: { equipmentId?: number; limit: number }): Promise<ServiceLog[]> {
  const rows = await sql`
    select l.id, e.name as equipment, r.name as rule,
      to_char(l.performed_on, 'YYYY-MM-DD') as performed_on, l.notes
    from service_logs l
    join equipment e on e.id = l.equipment_id
    left join maintenance_rules r on r.id = l.rule_id
    where l.deleted_at is null
      ${filter.equipmentId ? sql`and l.equipment_id = ${filter.equipmentId}` : sql``}
    order by l.performed_on desc, l.id desc
    limit ${filter.limit}
  `;
  return rows.map((r) => ({
    id: Number(r.id),
    equipment: r.equipment as string,
    rule: (r.rule as string | null) ?? null,
    performedOn: r.performed_on as string,
    notes: (r.notes as string | null) ?? null,
  }));
}
