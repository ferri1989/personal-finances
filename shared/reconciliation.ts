export type InternalTransfer = {
  id: string; accountId: string; accountName: string; date: string; amountCents: number;
};
export type TransferReconciliation = {
  count: number; matchedPairs: number; netCents: number; unmatched: InternalTransfer[];
};

// Pair each movement once, allowing bank posting dates to differ by up to a week.
export function reconcileTransfers(transfers: InternalTransfer[]): TransferReconciliation {
  const ordered = [...transfers].sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  const used = new Set<string>();
  let matchedPairs = 0;
  const day = (date: string) => Date.parse(`${date}T00:00:00Z`) / 86400000;
  for (const outgoing of ordered.filter(row => row.amountCents < 0)) {
    const incoming = ordered.filter(row => !used.has(row.id) && row.accountId !== outgoing.accountId
      && row.amountCents === -outgoing.amountCents && Math.abs(day(row.date) - day(outgoing.date)) <= 7)
      .sort((a, b) => Math.abs(day(a.date) - day(outgoing.date)) - Math.abs(day(b.date) - day(outgoing.date)))[0];
    if (incoming) { used.add(outgoing.id); used.add(incoming.id); matchedPairs++; }
  }
  return { count: ordered.length, matchedPairs, netCents: ordered.reduce((sum, row) => sum + row.amountCents, 0),
    unmatched: ordered.filter(row => !used.has(row.id)) };
}
