"use server";

import { revalidatePath } from "next/cache";
import { addFoodLog, addWeightLog, deleteFoodLog, deleteWeightLog } from "@/lib/queries";

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

function loggedAtOrNow(formData: FormData): string {
  const raw = str(formData, "loggedAt");
  return raw ? new Date(raw).toISOString() : new Date().toISOString();
}

export async function logWeight(formData: FormData) {
  const weightKg = num(formData, "weightKg");
  if (weightKg == null) return;

  await addWeightLog({
    loggedAt: loggedAtOrNow(formData),
    weightKg,
    bodyFatPct: num(formData, "bodyFatPct"),
    skeletalMuscleMassKg: num(formData, "skeletalMuscleMassKg"),
    waistCm: num(formData, "waistCm"),
    note: str(formData, "note"),
  });

  revalidatePath("/");
  revalidatePath("/log");
  revalidatePath("/trends");
}

export async function logFood(formData: FormData) {
  const calories = num(formData, "calories");
  const description = str(formData, "description");
  if (calories == null || !description) return;

  await addFoodLog({
    loggedAt: loggedAtOrNow(formData),
    description,
    calories,
    proteinG: num(formData, "proteinG"),
    carbsG: num(formData, "carbsG"),
    fatG: num(formData, "fatG"),
    meal: str(formData, "meal"),
  });

  revalidatePath("/");
  revalidatePath("/log");
  revalidatePath("/trends");
}

export async function removeWeightLog(id: string) {
  await deleteWeightLog(id);
  revalidatePath("/");
  revalidatePath("/log");
  revalidatePath("/trends");
}

export async function removeFoodLog(id: string) {
  await deleteFoodLog(id);
  revalidatePath("/");
  revalidatePath("/log");
  revalidatePath("/trends");
}
