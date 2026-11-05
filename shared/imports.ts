import type { Account } from './accounts.js';

export type ColumnMapping = {
  date: number;
  valueDate: number;
  description: number;
  amount: number;
  balance: number;
  category: number;
  subcategory: number;
  comment: number;
};

export type ImportDocumentInfo = {
  token: string;
  filename: string;
  detectedBank: 'ING' | 'Openbank' | 'Sabadell' | 'MyInvestor' | null;
  /** El extracto es de una tarjeta de crédito: sus compras son deuda que se cobra el mes siguiente. */
  creditCard?: boolean;
  headers: string[];
  mapping: ColumnMapping;
  sample: string[][];
  rowCount: number;
  lastFour: string;
  owner: string;
  firstDate: string;
  lastDate: string;
};

export type ParsedMovement = {
  date: string;
  valueDate: string | null;
  description: string;
  amountCents: number;
  balanceAfterCents: number | null;
  category: string;
  subcategory: string;
  comment: string;
  sourceRow: number;
  fingerprint: string;
};

export type ImportPlanInfo = {
  id: string;
  accountId: string | null;
  accountName: string;
  firstImport: boolean;
  extendStart?: boolean;
  startDate: string;
  openingBalanceCents: number;
  firstDate: string;
  lastDate: string;
  excludedCount: number;
  duplicateCount: number;
  newCount: number;
  newNetCents: number;
  resultingBalanceCents: number;
  statementClosingCents: number | null;
  reconciliation: 'matches' | 'unavailable' | 'historical' | 'differs';
  differenceCents: number | null;
  warnings: string[];
  rows: (ParsedMovement & { duplicate: boolean })[];
};

export type ImportResult = { account: Account; imported: number; duplicates: number };

export type Movement = {
  id: string;
  accountId: string;
  accountName: string;
  bank: string;
  date: string;
  valueDate: string | null;
  description: string;
  amountCents: number;
  balanceAfterCents: number | null;
  category: string;
  subcategory: string;
  comment: string;
  filename: string;
  lineId: string | null;
  excluded: boolean;
  assignmentVersion: number;
};

export type ImportBatch = {
  id: string;
  accountId: string;
  accountName: string;
  filename: string;
  bank: string;
  importedAt: string;
  rowCount: number;
};
