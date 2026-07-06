"use client";

import { useRef } from "react";
import { logSet } from "./actions";

function nowForInput() {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
}

const inputClass =
  "rounded-xl border border-border bg-background px-3 py-2.5 outline-none focus:border-accent";

export function SetForm() {
  const formRef = useRef<HTMLFormElement>(null);

  async function handleSubmit(formData: FormData) {
    const local = formData.get("loggedAt");
    if (typeof local === "string" && local) {
      formData.set("loggedAt", new Date(local).toISOString());
    }
    await logSet(formData);
    formRef.current?.reset();
  }

  return (
    <form ref={formRef} action={handleSubmit} className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-4">
        <label className="flex flex-col gap-1.5 text-sm">
          <span className="text-muted">Exercise</span>
          <input required name="exercise" type="text" placeholder="Bench Press" className={inputClass} />
        </label>
        <label className="flex flex-col gap-1.5 text-sm">
          <span className="text-muted">Muscle group (optional)</span>
          <input name="muscleGroup" type="text" placeholder="push" className={inputClass} />
        </label>
      </div>
      <div className="grid grid-cols-2 gap-4">
        <label className="flex flex-col gap-1.5 text-sm">
          <span className="text-muted">Weight kg (0 = bodyweight)</span>
          <input name="weightKg" type="number" step="0.5" min="0" inputMode="decimal" placeholder="80" className={inputClass} />
        </label>
        <label className="flex flex-col gap-1.5 text-sm">
          <span className="text-muted">Reps</span>
          <input required name="reps" type="number" step="1" min="1" inputMode="numeric" placeholder="5" className={inputClass} />
        </label>
      </div>
      <div className="grid grid-cols-3 gap-4">
        <label className="flex flex-col gap-1.5 text-sm">
          <span className="text-muted">RPE (optional)</span>
          <input name="rpe" type="number" step="0.5" min="0" max="10" inputMode="decimal" placeholder="8" className={inputClass} />
        </label>
        <label className="flex flex-col gap-1.5 text-sm">
          <span className="text-muted">RIR (optional)</span>
          <input name="rir" type="number" step="1" min="0" max="10" inputMode="numeric" placeholder="2" className={inputClass} />
        </label>
        <label className="flex flex-col gap-1.5 text-sm">
          <span className="text-muted">When</span>
          <input name="loggedAt" type="datetime-local" defaultValue={nowForInput()} className={inputClass} />
        </label>
      </div>
      <button
        type="submit"
        className="rounded-xl bg-accent px-4 py-2.5 text-sm font-medium text-accent-foreground transition-opacity hover:opacity-90"
      >
        Log set
      </button>
    </form>
  );
}
