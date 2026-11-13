// Bedrock cost ledger: ~/.local/state/claude-bedrock/cost.jsonl, appended by
// the agent's ACP launcher (bb threads) and optionally other tools (terminal
// sessions).
// Each line: { t: epoch ms, src: "bb" | "cli", key, usd } where usd is Claude
// Code's running list-price cost of one session (key) in one process.

export interface LedgerEntry {
  t: number;
  key: string;
  usd: number;
}

export interface CostTotals {
  /** List-price USD spent since the start of the current local month. */
  month: number;
  /** List-price USD spent since local midnight. */
  today: number;
  /** Time of the newest entry, or null for an empty ledger. */
  lastAt: number | null;
}

export function parseLedger(text: string): LedgerEntry[] {
  const entries: LedgerEntry[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as Partial<LedgerEntry>;
      if (typeof e.t === "number" && typeof e.key === "string" && typeof e.usd === "number" && e.usd >= 0) {
        entries.push({ t: e.t, key: e.key, usd: e.usd });
      }
    } catch {
      // a torn or foreign line: skip it
    }
  }
  return entries;
}

/**
 * Turns per-session running totals into spend per period: each entry
 * contributes its increase over the session's previous entry, counted at the
 * entry's time. A drop means Claude Code restarted its counter (e.g. a resumed
 * session), so the whole new value counts.
 */
export function totals(entries: LedgerEntry[], now = new Date()): CostTotals {
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const last = new Map<string, number>();
  const result: CostTotals = { month: 0, today: 0, lastAt: null };
  for (const e of [...entries].sort((a, b) => a.t - b.t)) {
    const prev = last.get(e.key);
    const delta = prev === undefined || e.usd < prev ? e.usd : e.usd - prev;
    last.set(e.key, e.usd);
    if (e.t >= monthStart) result.month += delta;
    if (e.t >= dayStart) result.today += delta;
    result.lastAt = e.t;
  }
  return result;
}
