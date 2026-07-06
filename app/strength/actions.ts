"use server";

import { revalidatePath } from "next/cache";
import { addSet, nextSetNumber, resolveManualSession, upsertExercise } from "@/lib/strength";
import { dayKeyInZone } from "@/lib/time";

function num(formData: FormData, key: string): number | null {
  const raw = formData.get(key);
  if (typeof raw !== "string" || raw.trim() === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function str(formData: FormData, key: string): string | null {
  const raw = formData.get(key);
  return typeof raw === "string" && raw.trim() !== "" ? raw.trim() : null;
}

// Mirrors the log_set MCP tool: resolve/create the exercise and the day's
// session, auto-number the set, insert it.
export async function logSet(formData: FormData) {
  const exercise = str(formData, "exercise");
  const reps = num(formData, "reps");
  if (!exercise || reps == null) return;

  const loggedAtRaw = str(formData, "loggedAt");
  const iso = loggedAtRaw ? new Date(loggedAtRaw).toISOString() : new Date().toISOString();
  const sessionDate = dayKeyInZone(new Date(iso));

  const exerciseId = await upsertExercise({ name: exercise, muscleGroup: str(formData, "muscleGroup") });
  const sessionId = await resolveManualSession(sessionDate);
  const setNumber = await nextSetNumber(sessionId, exerciseId);
  await addSet({
    sessionId,
    exerciseId,
    setNumber,
    weight: num(formData, "weightKg") ?? 0,
    reps,
    rpe: num(formData, "rpe"),
    rir: num(formData, "rir"),
  });

  revalidatePath("/strength");
  revalidatePath("/recovery");
}
