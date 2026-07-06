"use server";

import { revalidatePath } from "next/cache";
import { upsertGoal } from "@/lib/queries";
import { asGoalPhase } from "@/lib/goals";

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

export async function saveGoal(formData: FormData) {
  await upsertGoal({
    startingWeightKg: num(formData, "startingWeightKg"),
    startingDate: str(formData, "startingDate"),
    targetWeightKg: num(formData, "targetWeightKg"),
    targetDate: str(formData, "targetDate"),
    dailyCalorieTarget: num(formData, "dailyCalorieTarget"),
    dailyProteinTarget: num(formData, "dailyProteinTarget"),
    phase: asGoalPhase(formData.get("phase")),
  });

  revalidatePath("/");
  revalidatePath("/goals");
  revalidatePath("/trends");
}
