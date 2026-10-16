import { sql, type Db } from "./db";
import { addStockEvent } from "./fuel";

export const BASE_CURRENCY = "USD";

export const EXPENSE_CATEGORIES = [
  "equipment",
  "consumables",
  "maintenance",
  "registration",
  "travel",
  "rentals",
  "other",
] as const;
export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number];

export const EXPENSE_STATUSES = ["planned", "paid"] as const;
export type ExpenseStatus = (typeof EXPENSE_STATUSES)[number];

export type StockLotInput = { consumableId: number; servings: number; expiresOn: string | null };

export type Expense = {
  id: number;
  description: string;
  category: ExpenseCategory;
  status: ExpenseStatus;
  date: string;
  amount: number;
  currency: string;
  usdPerUnit: number | null;
  // Null when the currency is not USD and no rate was declared.
  amountUsd: number | null;
  equipment: string | null;
  race: string | null;
  stock: { product: string; servings: number; expiresOn: string | null }[];
  notes: string | null;
  deletedAt: string | null;
};

// Paying for an item that was only needed puts it in hand: owned, or rented when
// the money was a rental. Runs inside the write that records the payment, so the
// inventory can never show a paid-for item as still missing. Anything already
// in hand keeps its status.
async function acquireIfNeeded(
  db: Db,
  expense: { equipmentId: number | null; category: ExpenseCategory; date: string },
): Promise<boolean> {
  if (expense.equipmentId == null) return false;
  const rows = await db`
    update equipment set
      status = ${expense.category === "rentals" ? "rented" : "owned"},
      acquired_on = coalesce(acquired_on, ${expense.date}::date),
      updated_at = now()
    where id = ${expense.equipmentId} and status = 'needed'
    returning id
  `;
  return rows.length > 0;
}

export async function createExpense(input: {
  description: string;
  category: ExpenseCategory;
  status: ExpenseStatus;
  date: string;
  amount: number;
  currency: string;
  usdPerUnit: number | null;
  equipmentId: number | null;
  raceId: number | null;
  stock: StockLotInput[];
  notes: string | null;
}): Promise<{ id: number; acquired: boolean }> {
  return sql.begin(async (tx) => {
    const [row] = await tx`
      insert into expenses
        (description, category, status, expense_date, amount, currency, usd_per_unit,
         equipment_id, race_id, notes)
      values (
        ${input.description}, ${input.category}, ${input.status}, ${input.date}::date,
        ${input.amount}, ${input.currency}, ${input.usdPerUnit}, ${input.equipmentId},
        ${input.raceId}, ${input.notes}
      )
      returning id
    `;
    const id = Number(row.id);
    for (const lot of input.stock) {
      await addStockEvent(
        {
          consumableId: lot.consumableId,
          servings: lot.servings,
          occurredOn: input.date,
          expiresOn: lot.expiresOn,
          note: input.description,
          expenseId: id,
        },
        tx,
      );
    }
    const acquired = input.status === "paid" && (await acquireIfNeeded(tx, input));
    return { id, acquired };
  });
}

export async function updateExpense(
  id: number,
  patch: {
    description?: string;
    category?: ExpenseCategory;
    status?: ExpenseStatus;
    date?: string;
    amount?: number;
    currency?: string;
    usdPerUnit?: number | null;
    raceId?: number | null;
    notes?: string | null;
  },
): Promise<{ acquired: boolean } | { error: string } | null> {
  return sql.begin(async (tx) => {
    const [current] = await tx`
      select id, currency, usd_per_unit from expenses where id = ${id} and deleted_at is null for update
    `;
    if (!current) return null;
    // A booking's cost must stay in its race's budget (see setRaceTask), so the
    // task's link has to go before the expense can leave that race.
    if (patch.raceId !== undefined) {
      const [holder] = await tx`
        select t.title, r.name as race
        from race_tasks t join races r on r.id = t.race_id
        where t.expense_id = ${id} and t.race_id is distinct from ${patch.raceId}
        limit 1
      `;
      if (holder) {
        return {
          error: `Expense ${id} pays for "${holder.title}" on ${holder.race}; unlink it there first (set_race_task expense_id: null).`,
        };
      }
    }
    const currency = patch.currency ?? (current.currency as string);
    // A rate belongs to a currency: switching currency without a new rate drops
    // the old one rather than applying it to the wrong money.
    const usdPerUnit =
      patch.usdPerUnit !== undefined
        ? patch.usdPerUnit
        : patch.currency !== undefined && patch.currency !== current.currency
          ? null
          : current.usd_per_unit;
    if (currency === BASE_CURRENCY && usdPerUnit != null) {
      return { error: `A ${BASE_CURRENCY} expense takes no rate.` };
    }
    const keep = (value: unknown, column: string) =>
      value === undefined ? tx(column) : tx`${value as string | number | null}`;
    const [row] = await tx`
      update expenses set
        description = ${keep(patch.description, "description")},
        category = ${keep(patch.category, "category")},
        status = ${keep(patch.status, "status")},
        expense_date = coalesce(${patch.date ?? null}::date, expense_date),
        amount = ${keep(patch.amount, "amount")},
        currency = ${currency},
        usd_per_unit = ${usdPerUnit},
        race_id = ${keep(patch.raceId, "race_id")},
        notes = ${keep(patch.notes, "notes")},
        updated_at = now()
      where id = ${id}
      returning equipment_id, category, status, to_char(expense_date, 'YYYY-MM-DD') as date
    `;
    const acquired =
      row.status === "paid" &&
      (await acquireIfNeeded(tx, {
        equipmentId: row.equipment_id == null ? null : Number(row.equipment_id),
        category: row.category as ExpenseCategory,
        date: row.date as string,
      }));
    return { acquired };
  });
}

export async function setExpenseDeleted(id: number, deleted: boolean): Promise<boolean> {
  const rows = deleted
    ? await sql`
        update expenses set deleted_at = now(), updated_at = now()
        where id = ${id} and deleted_at is null returning id
      `
    : await sql`
        update expenses set deleted_at = null, updated_at = now()
        where id = ${id} and deleted_at is not null returning id
      `;
  return rows.length > 0;
}

// Converted to the cent, as a card statement would show it.
function amountUsd(amount: number, currency: string, usdPerUnit: number | null): number | null {
  if (currency === BASE_CURRENCY) return amount;
  return usdPerUnit == null ? null : Math.round(amount * usdPerUnit * 100) / 100;
}

const cents = (usd: number) => Math.round(usd * 100);

export async function listExpenses(filter: {
  from?: string;
  to?: string;
  status?: ExpenseStatus;
  category?: ExpenseCategory;
  raceId?: number;
  ids?: number[];
  includeDeleted?: boolean;
}): Promise<Expense[]> {
  const rows = await sql`
    select
      x.id, x.description, x.category, x.status, to_char(x.expense_date, 'YYYY-MM-DD') as date,
      x.amount, x.currency, x.usd_per_unit, e.name as equipment, r.name as race, x.notes,
      x.deleted_at,
      coalesce((
        select json_agg(json_build_object(
          'product', c.name, 'servings', se.servings,
          'expiresOn', to_char(se.expires_on, 'YYYY-MM-DD')
        ) order by se.id)
        from stock_events se join consumables c on c.id = se.consumable_id
        where se.expense_id = x.id
      ), '[]') as stock
    from expenses x
    left join equipment e on e.id = x.equipment_id
    left join races r on r.id = x.race_id
    where true
      ${filter.from ? sql`and x.expense_date >= ${filter.from}::date` : sql``}
      ${filter.to ? sql`and x.expense_date <= ${filter.to}::date` : sql``}
      ${filter.status ? sql`and x.status = ${filter.status}` : sql``}
      ${filter.category ? sql`and x.category = ${filter.category}` : sql``}
      ${filter.raceId ? sql`and x.race_id = ${filter.raceId}` : sql``}
      ${filter.ids ? sql`and x.id = any(${filter.ids})` : sql``}
      ${filter.includeDeleted ? sql`` : sql`and x.deleted_at is null`}
    order by x.expense_date desc, x.id desc
  `;
  return rows.map((r) => {
    const amount = Number(r.amount);
    const usdPerUnit = r.usd_per_unit == null ? null : Number(r.usd_per_unit);
    return {
      id: Number(r.id),
      description: r.description as string,
      category: r.category as ExpenseCategory,
      status: r.status as ExpenseStatus,
      date: r.date as string,
      amount,
      currency: r.currency as string,
      usdPerUnit,
      amountUsd: amountUsd(amount, r.currency as string, usdPerUnit),
      equipment: (r.equipment as string | null) ?? null,
      race: (r.race as string | null) ?? null,
      stock: (r.stock as { product: string; servings: number; expiresOn: string | null }[]).map((l) => ({
        ...l,
        servings: Number(l.servings),
      })),
      notes: (r.notes as string | null) ?? null,
      deletedAt: r.deleted_at ? (r.deleted_at as Date).toISOString() : null,
    };
  });
}

export type CategoryTotals = { paidUsd: number; plannedUsd: number };

export type BudgetSummary = {
  paidUsd: number;
  plannedUsd: number;
  byCategory: Partial<Record<ExpenseCategory, CategoryTotals>>;
  // Expenses that cannot enter a USD total until a rate is declared on them,
  // summed in their own currency.
  unconverted: { currency: string; status: ExpenseStatus; amount: number; expenseIds: number[] }[];
};

// Summed in whole cents so totals never pick up floating-point dust.
export function summarizeBudget(expenses: Expense[]): BudgetSummary {
  const totalCents = { paid: 0, planned: 0 };
  const categoryCents = new Map<ExpenseCategory, { paid: number; planned: number }>();
  const unconverted = new Map<string, { currency: string; status: ExpenseStatus; cents: number; expenseIds: number[] }>();
  for (const x of expenses) {
    if (x.amountUsd == null) {
      const key = `${x.currency}:${x.status}`;
      const bucket = unconverted.get(key) ?? { currency: x.currency, status: x.status, cents: 0, expenseIds: [] };
      bucket.cents += cents(x.amount);
      bucket.expenseIds.push(x.id);
      unconverted.set(key, bucket);
      continue;
    }
    const category = categoryCents.get(x.category) ?? { paid: 0, planned: 0 };
    category[x.status] += cents(x.amountUsd);
    totalCents[x.status] += cents(x.amountUsd);
    categoryCents.set(x.category, category);
  }
  return {
    paidUsd: totalCents.paid / 100,
    plannedUsd: totalCents.planned / 100,
    byCategory: Object.fromEntries(
      [...categoryCents].map(([category, c]) => [category, { paidUsd: c.paid / 100, plannedUsd: c.planned / 100 }]),
    ),
    unconverted: [...unconverted.values()].map(({ cents: c, ...rest }) => ({ ...rest, amount: c / 100 })),
  };
}
