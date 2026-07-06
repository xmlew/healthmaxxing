"use client";

import { useRef } from "react";
import { logWeight } from "./actions";

function nowForInput() {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
}

export function WeightForm() {
  const formRef = useRef<HTMLFormElement>(null);

  async function handleSubmit(formData: FormData) {
    const local = formData.get("loggedAt");
    if (typeof local === "string" && local) {
      formData.set("loggedAt", new Date(local).toISOString());
    }
    await logWeight(formData);
    formRef.current?.reset();
  }

  return (
    <form ref={formRef} action={handleSubmit} className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-4">
        <label className="flex flex-col gap-1.5 text-sm">
          <span className="text-muted">Weight (kg)</span>
          <input
            required
            name="weightKg"
            type="number"
            step="0.1"
            inputMode="decimal"
            placeholder="82.4"
            className="rounded-xl border border-border bg-background px-3 py-2.5 outline-none focus:border-accent"
          />
        </label>
        <label className="flex flex-col gap-1.5 text-sm">
          <span className="text-muted">Body fat % (optional)</span>
          <input
            name="bodyFatPct"
            type="number"
            step="0.1"
            min="0"
            max="100"
            inputMode="decimal"
            placeholder="18.5"
            className="rounded-xl border border-border bg-background px-3 py-2.5 outline-none focus:border-accent"
          />
        </label>
      </div>
      <div className="grid grid-cols-2 gap-4">
        <label className="flex flex-col gap-1.5 text-sm">
          <span className="text-muted">Muscle mass kg (optional)</span>
          <input
            name="skeletalMuscleMassKg"
            type="number"
            step="0.1"
            inputMode="decimal"
            placeholder="35.2"
            className="rounded-xl border border-border bg-background px-3 py-2.5 outline-none focus:border-accent"
          />
        </label>
        <label className="flex flex-col gap-1.5 text-sm">
          <span className="text-muted">Waist cm (optional)</span>
          <input
            name="waistCm"
            type="number"
            step="0.1"
            inputMode="decimal"
            placeholder="81"
            className="rounded-xl border border-border bg-background px-3 py-2.5 outline-none focus:border-accent"
          />
        </label>
      </div>
      <label className="flex flex-col gap-1.5 text-sm">
        <span className="text-muted">Note (optional)</span>
        <input
          name="note"
          type="text"
          placeholder="Morning, fasted"
          className="rounded-xl border border-border bg-background px-3 py-2.5 outline-none focus:border-accent"
        />
      </label>
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
        Log weight
      </button>
    </form>
  );
}
