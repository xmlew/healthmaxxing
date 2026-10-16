import { sql, valueOrKeep } from "./db";

export const EQUIPMENT_STATUSES = ["needed", "owned", "rented", "borrowed", "retired"] as const;
export type EquipmentStatus = (typeof EQUIPMENT_STATUSES)[number];

// Statuses under which an item is in hand: it can be used in a session and can
// fill a race requirement. A "needed" item does not exist yet; a retired one is
// kept for its history.
export const IN_HAND_STATUSES: readonly EquipmentStatus[] = ["owned", "rented", "borrowed"];

export type EquipmentUsage = {
  sessions: number;
  distanceKm: number;
  durationMin: number;
  // Linked legs that recorded no distance; distanceKm is a floor while this is
  // above zero.
  segmentsWithoutDistance: number;
  lastUsed: string | null;
};

export type Equipment = {
  id: number;
  name: string;
  category: string;
  status: EquipmentStatus;
  quantity: number;
  location: string | null;
  acquiredOn: string | null;
  fitNotes: string | null;
  notes: string | null;
  usage: EquipmentUsage;
};

export type EquipmentPatch = {
  category?: string;
  status?: EquipmentStatus;
  quantity?: number;
  location?: string | null;
  acquiredOn?: string | null;
  fitNotes?: string | null;
  notes?: string | null;
};

// Upserts by case-insensitive name. On update, a field left undefined keeps its
// stored value and an explicit null clears it.
export async function setEquipment(
  name: string,
  patch: EquipmentPatch,
): Promise<{ id: number; created: boolean } | { error: string }> {
  const [existing] = await sql`select id from equipment where lower(name) = lower(${name})`;
  if (!existing) {
    if (!patch.category) return { error: `"${name}" is new; give it a category (e.g. bike, wetsuit, shoes).` };
    const [row] = await sql`
      insert into equipment (name, category, status, quantity, location, acquired_on, fit_notes, notes)
      values (
        ${name}, ${patch.category.toLowerCase()}, ${patch.status ?? "owned"}, ${patch.quantity ?? 1},
        ${patch.location ?? null}, ${patch.acquiredOn ?? null}::date,
        ${patch.fitNotes ?? null}, ${patch.notes ?? null}
      )
      returning id
    `;
    return { id: Number(row.id), created: true };
  }
  await sql`
    update equipment set
      category = ${patch.category === undefined ? sql`category` : patch.category.toLowerCase()},
      status = ${valueOrKeep(sql, patch.status, "status")},
      quantity = ${valueOrKeep(sql, patch.quantity, "quantity")},
      location = ${valueOrKeep(sql, patch.location, "location")},
      acquired_on = ${patch.acquiredOn === undefined ? sql`acquired_on` : sql`${patch.acquiredOn}::date`},
      fit_notes = ${valueOrKeep(sql, patch.fitNotes, "fit_notes")},
      notes = ${valueOrKeep(sql, patch.notes, "notes")},
      updated_at = now()
    where id = ${existing.id}
  `;
  return { id: Number(existing.id), created: false };
}

export async function listEquipment(filter: { ids?: number[] } = {}): Promise<Equipment[]> {
  // Usage counts only completed, undeleted sessions; planned sessions and the
  // recycle bin still list the item, they just add nothing to it.
  const rows = await sql`
    select
      e.id, e.name, e.category, e.status, e.quantity, e.location,
      to_char(e.acquired_on, 'YYYY-MM-DD') as acquired_on, e.fit_notes, e.notes,
      count(distinct ts.id) filter (where counted) as sessions,
      coalesce(sum(seg.distance_km) filter (where counted), 0) as distance_km,
      coalesce(sum(seg.duration_min) filter (where counted), 0) as duration_min,
      count(seg.id) filter (where counted and seg.distance_km is null) as segments_without_distance,
      to_char(max(ts.session_date) filter (where counted), 'YYYY-MM-DD') as last_used
    from equipment e
    left join training_segment_equipment tse on tse.equipment_id = e.id
    left join training_segments seg on seg.id = tse.segment_id
    left join training_sessions ts on ts.id = seg.session_id
    cross join lateral (
      select coalesce(ts.status = 'completed' and ts.deleted_at is null, false) as counted
    ) c
    where true ${filter.ids ? sql`and e.id = any(${filter.ids})` : sql``}
    group by e.id
    order by e.category, e.name
  `;
  return rows.map((r) => ({
    id: Number(r.id),
    name: r.name as string,
    category: r.category as string,
    status: r.status as EquipmentStatus,
    quantity: Number(r.quantity),
    location: (r.location as string | null) ?? null,
    acquiredOn: (r.acquired_on as string | null) ?? null,
    fitNotes: (r.fit_notes as string | null) ?? null,
    notes: (r.notes as string | null) ?? null,
    usage: {
      sessions: Number(r.sessions),
      distanceKm: Number(r.distance_km),
      durationMin: Number(r.duration_min),
      segmentsWithoutDistance: Number(r.segments_without_distance),
      lastUsed: (r.last_used as string | null) ?? null,
    },
  }));
}

// Resolves names to ids for linking to a session, refusing anything that is not
// in hand. Unknown names fail rather than creating gear, so a typo cannot add a
// phantom item to the inventory. Items in `alreadyLinked` (the gear a session
// being edited already records) pass whatever their status now: retiring a bike
// must not make last year's rides uneditable or drop them from its history.
export async function resolveUsableEquipment(
  names: string[],
  alreadyLinked: ReadonlySet<number> = new Set(),
): Promise<{ ids: Map<string, number> } | { error: string }> {
  const unique = [...new Set(names.map((n) => n.trim().toLowerCase()))];
  if (unique.length === 0) return { ids: new Map() };
  const rows = await sql`
    select id, name, status from equipment where lower(name) = any(${unique})
  `;
  const byName = new Map(rows.map((r) => [(r.name as string).toLowerCase(), r]));
  const unknown = unique.filter((n) => !byName.has(n));
  if (unknown.length > 0) {
    const known = await sql`select name from equipment where status <> 'retired' order by name`;
    return {
      error: `Unknown equipment: ${unknown.join(", ")}. Known: ${
        known.map((k) => k.name).join(", ") || "none"
      }. Add it with set_equipment first.`,
    };
  }
  const notInHand = rows.filter(
    (r) => !IN_HAND_STATUSES.includes(r.status as EquipmentStatus) && !alreadyLinked.has(Number(r.id)),
  );
  if (notInHand.length > 0) {
    return {
      error: `Not in hand: ${notInHand
        .map((r) => `${r.name} (${r.status})`)
        .join(", ")}. Update its status with set_equipment before logging it on a session.`,
    };
  }
  return { ids: new Map(rows.map((r) => [(r.name as string).toLowerCase(), Number(r.id)])) };
}
