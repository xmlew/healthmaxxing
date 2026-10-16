import type { Sql, TransactionSql } from "postgres";
import type { Sport } from "./sports";

export type Db = Sql | TransactionSql;

export type SegmentInput = {
  sport: Sport;
  durationMin: number | null;
  distanceKm: number | null;
  equipmentIds: number[];
};

// Takes its connection rather than importing lib/db, so a caller can write a
// session's segments inside the transaction that writes the session.
export async function insertSegments(db: Db, sessionId: number, segments: SegmentInput[]): Promise<void> {
  for (const [index, segment] of segments.entries()) {
    const [row] = await db`
      insert into training_segments (session_id, position, sport, duration_min, distance_km)
      values (${sessionId}, ${index + 1}, ${segment.sport}, ${segment.durationMin}, ${segment.distanceKm})
      returning id
    `;
    if (segment.equipmentIds.length > 0) {
      await db`
        insert into training_segment_equipment ${db(
          [...new Set(segment.equipmentIds)].map((equipmentId) => ({
            segment_id: row.id,
            equipment_id: equipmentId,
          })),
        )}
      `;
    }
  }
}
