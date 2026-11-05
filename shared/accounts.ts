import { z } from 'zod';

export const banks = ['ING', 'Openbank', 'Sabadell', 'MyInvestor', 'Otro', 'Efectivo'] as const;
export const accountTypes = {
  current: 'Cuenta corriente',
  savings: 'Cuenta de ahorro',
  investment_cash: 'Efectivo de inversión',
  cash: 'Efectivo',
} as const;

export function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value < '1900-01-01' || value > '2200-12-31') return false;
  const date = new Date(`${value}T12:00:00Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

export const accountInputSchema = z.object({
  name: z.string().trim().min(1, 'Escribe un nombre para la cuenta.').max(80),
  bank: z.enum(banks),
  type: z.enum(['current', 'savings', 'investment_cash', 'cash']),
  owner: z.string().trim().max(80).default(''),
  lastFour: z.string().regex(/^(\d{4})?$/, 'Introduce solo los cuatro últimos dígitos.').default(''),
  openingDate: z.string().refine(validDate, 'La fecha del saldo inicial no es válida.'),
  openingBalanceCents: z.number().int().min(-1_000_000_000_000).max(1_000_000_000_000),
}).strict();

export type AccountInput = z.infer<typeof accountInputSchema>;
export type Account = AccountInput & {
  id: string;
  currency: 'EUR';
  balanceCents: number;
  archived: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
  movementCount: number;
};

// Decimal strings are converted directly to cents, avoiding floating-point rounding.
export function parseEuros(raw: string): number | null {
  const value = raw.trim();
  if (!/^-?\d+(?:[.,]\d{1,2})?$/.test(value)) return null;
  const negative = value.startsWith('-');
  const [whole, fraction = ''] = value.replace(/^-/, '').split(/[.,]/);
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (!Number.isSafeInteger(cents) || cents > 1_000_000_000_000) return null;
  return negative ? -cents : cents;
}

export function formatEuros(cents: number): string {
  return new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' }).format(cents === 0 ? 0 : cents / 100);
}

export function localDate(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}
