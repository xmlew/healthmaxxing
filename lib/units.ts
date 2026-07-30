// Lift weights are entered and displayed in pounds but stored in kilograms.
// Kilograms are the canonical unit across the schema (weight_logs.weight_kg,
// Apple Health), so keeping lifts in kg too means training volume stays
// summable across exercises and no reader has to ask which unit a row is in.
// Conversion happens only at the edges: MCP tool arguments and rendered UI.
export const LB_PER_KG = 2.20462262185;

export const lbToKg = (lb: number): number => lb / LB_PER_KG;
export const kgToLb = (kg: number): number => kg * LB_PER_KG;

// Pounds for display. Plate-loaded weights round-trip exactly at one decimal
// (40 lb -> 18.1436948 kg -> 40 lb), and dumbbells never need finer precision.
export const displayLb = (kg: number): number => Math.round(kgToLb(kg) * 10) / 10;

// Volume is weight x reps, so it converts on the same factor as weight itself.
// Rounded to a whole pound - a session total of "3,241 lb" carries no useful
// fraction.
//
// Unlike a stored weight, training volume is only ever derived and reported: it
// is never written back, and the stall/overreaching checks that consume it
// compare a group against its own baseline, so they are scale-invariant. That
// makes its unit a presentation choice, and it is made once at the point of
// derivation (computeOverloadStatus, weeklyVolumeByMuscleGroup) rather than
// separately in every renderer. Stored scalars stay kilograms and say so in
// their name (weightKg); derived volumes are pounds and say so too (volumeLb).
export const displayVolumeLb = (kgVolume: number): number => Math.round(kgToLb(kgVolume));
