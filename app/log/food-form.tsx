"use client";

import { useRef } from "react";
import { logFood } from "./actions";

function nowForInput() {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
}

export function FoodForm() {
  const formRef = useRef<HTMLFormElement>(null);

  async function handleSubmit(formData: FormData) {
    const local = formData.get("loggedAt");
    if (typeof local === "string" && local) {
      formData.set("loggedAt", new Date(local).toISOString());
    }
    await logFood(formData);
    formRef.current?.reset();
  }

  return (
    <form ref={formRef} action={handleSubmit} className="flex flex-col gap-4">
      <label className="flex flex-col gap-1.5 text-sm">
        <span className="text-muted">What did you eat</span>
        <input
          required
          name="description"
          type="text"
          placeholder="Chicken burrito bowl"
          className="rounded-xl border border-border bg-background px-3 py-2.5 outline-none focus:border-accent"
        />
      </label>
      <div className="grid grid-cols-2 gap-4">
        <label className="flex flex-col gap-1.5 text-sm">
          <span className="text-muted">Calories</span>
          <input
            required
            name="calories"
            type="number"
            inputMode="numeric"
            placeholder="650"
            className="rounded-xl border border-border bg-background px-3 py-2.5 outline-none focus:border-accent"
          />
        </label>
        <label className="flex flex-col gap-1.5 text-sm">
          <span className="text-muted">Meal</span>
          <select
            name="meal"
            defaultValue="lunch"
            className="rounded-xl border border-border bg-background px-3 py-2.5 outline-none focus:border-accent"
          >
            <option value="breakfast">Breakfast</option>
            <option value="lunch">Lunch</option>
            <option value="dinner">Dinner</option>
            <option value="snack">Snack</option>
          </select>
        </label>
      </div>
      <div className="grid grid-cols-3 gap-4">
        <label className="flex flex-col gap-1.5 text-sm">
          <span className="text-muted">Protein (g)</span>
          <input
            name="proteinG"
            type="number"
            step="0.1"
            inputMode="decimal"
            className="rounded-xl border border-border bg-background px-3 py-2.5 outline-none focus:border-accent"
          />
        </label>
        <label className="flex flex-col gap-1.5 text-sm">
          <span className="text-muted">Carbs (g)</span>
          <input
            name="carbsG"
            type="number"
            step="0.1"
            inputMode="decimal"
            className="rounded-xl border border-border bg-background px-3 py-2.5 outline-none focus:border-accent"
          />
        </label>
        <label className="flex flex-col gap-1.5 text-sm">
          <span className="text-muted">Fat (g)</span>
          <input
            name="fatG"
            type="number"
            step="0.1"
            inputMode="decimal"
            className="rounded-xl border border-border bg-background px-3 py-2.5 outline-none focus:border-accent"
          />
        </label>
      </div>
      <label className="flex flex-col gap-1.5 text-sm">
        <span className="text-muted">When</span>
        <input
          name="loggedAt"
          type="datetime-local"
          defaultValue={nowForInput()}
          className="rounded-xl border border-border bg-background px-3 py-2.5 outline-none focus:border-accent"
        />
      </label>
      <button
        type="submit"
        className="rounded-xl bg-accent px-4 py-2.5 text-sm font-medium text-accent-foreground transition-opacity hover:opacity-90"
      >
        Log food
      </button>
    </form>
  );
}
