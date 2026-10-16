import { sql } from "./db";
import { expiryOf, type ExpiryStatus } from "./fuel-expiry";
import type { Db } from "./training-segments";

export type ConsumablePatch = {
  kind?: string;
  servingUnit?: string;
  carbsG?: number | null;
  sodiumMg?: number | null;
  caffeineMg?: number | null;
  lowStockServings?: number | null;
  notes?: string | null;
};

export type Consumable = {
  id: number;
  name: string;
  kind: string;
  servingUnit: string;
  carbsG: number | null;
  sodiumMg: number | null;
  caffeineMg: number | null;
  lowStockServings: number | null;
  notes: string | null;
  onHand: number;
  // Servings on planned sessions from today on; never deducted until completed.
  plannedNeed: number;
  shortfall: number;
  lowStock: boolean;
  expiry: ExpiryStatus;
};

export async function setConsumable(
  name: string,
  patch: ConsumablePatch,
): Promise<{ id: number; created: boolean } | { error: string }> {
  const [existing] = await sql`select id from consumables where lower(name) = lower(${name})`;
  if (!existing) {
    if (!patch.kind) return { error: `"${name}" is new; give it a kind (e.g. gel, drink mix, electrolyte, bar).` };
    const [row] = await sql`
      insert into consumables
        (name, kind, serving_unit, carbs_g, sodium_mg, caffeine_mg, low_stock_servings, notes)
      values (
        ${name}, ${patch.kind.toLowerCase()}, ${patch.servingUnit ?? "serving"},
        ${patch.carbsG ?? null}, ${patch.sodiumMg ?? null}, ${patch.caffeineMg ?? null},
        ${patch.lowStockServings ?? null}, ${patch.notes ?? null}
      )
      returning id
    `;
    return { id: Number(row.id), created: true };
  }
  const keep = (value: unknown, column: string) =>
    value === undefined ? sql(column) : sql`${value as string | number | null}`;
  await sql`
    update consumables set
      kind = ${patch.kind === undefined ? sql`kind` : patch.kind.toLowerCase()},
      serving_unit = ${keep(patch.servingUnit, "serving_unit")},
      carbs_g = ${keep(patch.carbsG, "carbs_g")},
      sodium_mg = ${keep(patch.sodiumMg, "sodium_mg")},
      caffeine_mg = ${keep(patch.caffeineMg, "caffeine_mg")},
      low_stock_servings = ${keep(patch.lowStockServings, "low_stock_servings")},
      notes = ${keep(patch.notes, "notes")},
      updated_at = now()
    where id = ${existing.id}
  `;
  return { id: Number(existing.id), created: false };
}

export async function addStockEvent(
  input: {
    consumableId: number;
    servings: number;
    occurredOn: string;
    expiresOn: string | null;
    note: string | null;
    expenseId?: number;
  },
  db: Db = sql,
): Promise<number> {
  const [row] = await db`
    insert into stock_events (consumable_id, servings, occurred_on, expires_on, note, expense_id)
    values (
      ${input.consumableId}, ${input.servings}, ${input.occurredOn}::date,
      ${input.expiresOn}::date, ${input.note}, ${input.expenseId ?? null}
    )
    returning id
  `;
  return Number(row.id);
}

export async function findConsumableIds(
  names: string[],
): Promise<{ ids: Map<string, number> } | { error: string }> {
  const unique = [...new Set(names.map((n) => n.trim().toLowerCase()))];
  if (unique.length === 0) return { ids: new Map() };
  const rows = await sql`select id, name from consumables where lower(name) = any(${unique})`;
  const ids = new Map(rows.map((r) => [(r.name as string).toLowerCase(), Number(r.id)]));
  const unknown = unique.filter((n) => !ids.has(n));
  if (unknown.length > 0) {
    const known = await sql`select name from consumables order by name`;
    return {
      error: `Unknown fuel: ${unknown.join(", ")}. Known: ${
        known.map((k) => k.name).join(", ") || "none"
      }. Add it with set_consumable first.`,
    };
  }
  return { ids };
}

// A lot bought with an expense counts only while that expense is paid and not
// deleted; lots entered as adjustments always count.
const COUNTED_STOCK_EVENT = sql`
  (se.expense_id is null or exists (
    select 1 from expenses x
    where x.id = se.expense_id and x.status = 'paid' and x.deleted_at is null
  ))
`;

export async function listConsumables(
  today: string,
  filter: { ids?: number[] } = {},
): Promise<Consumable[]> {
  const rows = await sql`
    select
      c.*,
      coalesce((
        select sum(se.servings) from stock_events se
        where se.consumable_id = c.id and ${COUNTED_STOCK_EVENT}
      ), 0) as stocked,
      coalesce((
        select sum(f.servings)
        from training_session_fuel f
        join training_sessions ts on ts.id = f.session_id
        where f.consumable_id = c.id and ts.status = 'completed' and ts.deleted_at is null
      ), 0) as consumed,
      coalesce((
        select sum(f.servings)
        from training_session_fuel f
        join training_sessions ts on ts.id = f.session_id
        where f.consumable_id = c.id and ts.status = 'planned' and ts.deleted_at is null
          and ts.session_date >= ${today}::date
      ), 0) as planned_need,
      coalesce((
        select json_agg(json_build_object(
          'servings', se.servings, 'expiresOn', to_char(se.expires_on, 'YYYY-MM-DD')
        ))
        from stock_events se
        where se.consumable_id = c.id and se.servings > 0 and ${COUNTED_STOCK_EVENT}
      ), '[]') as lots,
      coalesce((
        select -sum(se.servings) from stock_events se
        where se.consumable_id = c.id and se.servings < 0 and ${COUNTED_STOCK_EVENT}
      ), 0) as removed
    from consumables c
    where true ${filter.ids ? sql`and c.id = any(${filter.ids})` : sql``}
    order by c.kind, c.name
  `;
  return rows.map((r) => {
    const onHand = Number(r.stocked) - Number(r.consumed);
    const plannedNeed = Number(r.planned_need);
    const lowStockServings = r.low_stock_servings == null ? null : Number(r.low_stock_servings);
    return {
      id: Number(r.id),
      name: r.name as string,
      kind: r.kind as string,
      servingUnit: r.serving_unit as string,
      carbsG: r.carbs_g == null ? null : Number(r.carbs_g),
      sodiumMg: r.sodium_mg == null ? null : Number(r.sodium_mg),
      caffeineMg: r.caffeine_mg == null ? null : Number(r.caffeine_mg),
      lowStockServings,
      notes: (r.notes as string | null) ?? null,
      onHand,
      plannedNeed,
      shortfall: Math.max(0, plannedNeed - onHand),
      lowStock: lowStockServings != null && onHand <= lowStockServings,
      expiry: expiryOf(
        (r.lots as { servings: number; expiresOn: string | null }[]).map((l) => ({
          servings: Number(l.servings),
          expiresOn: l.expiresOn,
        })),
        Number(r.consumed) + Number(r.removed),
        today,
      ),
    };
  });
}
