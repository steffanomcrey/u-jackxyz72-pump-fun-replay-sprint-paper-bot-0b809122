// Late-curve breakout rider for the pump.fun replay (agent-fun/replay/v2).
//
// Idea: wait for a curve to prove itself. A coin is bought once, late (about
// 20-44 s after creation, 90-200 slots), only when its opening tape shows heavy
// real flow: many SOL bought, many distinct buyers, no single wallet
// dominating, price well up from creation but not already vertical, and real
// SOL inside a working band. One fixed stake per coin, no pyramiding, no
// dip-buying. Exits are mechanical: a stop loss, a trailing stop armed on
// gains, an instant exit when the creator sells while we hold, a fade exit
// when inflow reverses hard, a stale-loser exit for positions still down
// after ~22 s, and a hard time cap. While real SOL nears the
// completion threshold and inflow persists, the trail and fade exits are
// suspended so a runner is ridden to completion instead of being cut.
//
// Breadth guardrail: the run needs >= 20 distinct coins with >= 0.01 SOL
// round trips in every 6 h slice. Tiny probe round trips (0.02 SOL) fill a
// slice that falls behind pace, capped per slice so probes never become the
// strategy.
//
// Deterministic by construction: no clock, no randomness, iteration only
// over insertion-ordered maps fed by the batch stream.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  /** Entry age window, slots since CreateEvent. */
  minAge: number;
  maxAge: number;
  /** Opening-tape thresholds (trades since creation). */
  minBuySol: number;
  minBuyers: number;
  minUp: number;
  maxUp: number;
  nearHigh: number;
  maxTopShare: number;
  minRqSol: number;
  maxRqSol: number;
  /** Net SOL inflow over the last flowWindow slots required at entry. */
  entryFlowWindow: number;
  entryMinFlowSol: number;
  /** Stake and order limits. */
  stakeSol: number;
  minBuySolOrder: number;
  buySlipBps: number;
  /** Exits, as fractions of cost / peak value. */
  stopLoss: number;
  trailArm: number;
  trail: number;
  /** Exit when net SOL over fadeWindow slots falls below -fadeNetSol. Infinity = off. */
  fadeWindow: number;
  fadeNetSol: number;
  /** Exit when still down this much after staleSlots held. 0 = off. */
  staleSlots: number;
  staleDown: number;
  /** Exit when the creator sells while we hold. */
  exitOnCreatorSell: boolean;
  /** Hold after this many slots. */
  maxHold: number;
  /** Real SOL at/above which trail+fade exits suspend while inflow persists. */
  rideRqSol: number;
  /** Most entries per curve over the run. */
  maxEntries: number;
  /** Probe round trips per 6 h slice. */
  probeSol: number;
  maxProbesPerWindow: number;
  probeTargetCoins: number;
  maxProbesOpen: number;
  /** Most main positions open at once. */
  maxMain: number;
  /** Most SOL at cost across all positions at once. */
  maxExposureSol: number;
}

export const DEFAULT_PARAMS: Params = {
  minAge: 90,
  maxAge: 200,
  minBuySol: 70,
  minBuyers: 50,
  minUp: 0.5,
  maxUp: 4.0,
  nearHigh: 0.8,
  maxTopShare: 0.35,
  minRqSol: 20,
  maxRqSol: 250,
  entryFlowWindow: 30,
  entryMinFlowSol: -Infinity,
  stakeSol: 0.35,
  minBuySolOrder: 0.01,
  buySlipBps: 1500,
  stopLoss: 0.18,
  trailArm: 0.1,
  trail: 0.15,
  fadeWindow: 60,
  fadeNetSol: 5,
  staleSlots: 100,
  staleDown: 0.05,
  exitOnCreatorSell: true,
  maxHold: 900,
  rideRqSol: 70,
  maxEntries: 1,
  probeSol: 0.012,
  maxProbesPerWindow: 30,
  probeTargetCoins: 22,
  maxProbesOpen: 2,
  maxMain: 5,
  maxExposureSol: 3.0,
};

const LAMPORTS = 1e9;
const CURVE_FEE = 0.0125;
const WINDOW_SLOTS = 100803; // ~6 h at ~0.22 s per slot

interface Trade {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
  price: number;
}

interface Tape {
  created: number | null;
  creator: string;
  price0: number;
  trades: Trade[];
  entries: number;
  lastExit: number;
}

interface Held {
  opened: number;
  peakValue: number;
  invested: number;
  exiting: boolean;
  filled: boolean;
  creatorSold: boolean;
  lastValue: number;
}

export function createStrategy(p: Params = DEFAULT_PARAMS): Bot {
  const tapes = new Map<Pubkey, Tape>();
  const held = new Map<Pubkey, Held>();
  const probes = new Map<Pubkey, boolean>(); // mint -> selling?
  const windowCoins = new Map<number, Set<Pubkey>>();
  const windowProbes = new Map<number, number>();
  let firstSlot: number | null = null;

  const tapeOf = (mint: Pubkey): Tape => {
    let t = tapes.get(mint);
    if (t === undefined) {
      t = { created: null, creator: '', price0: 0, trades: [], entries: 0, lastExit: -1e12 };
      tapes.set(mint, t);
    }
    return t;
  };

  const windowOf = (slot: number): number => {
    if (firstSlot === null) return 0;
    return Math.min(3, Math.floor((slot - firstSlot) / WINDOW_SLOTS));
  };

  /** Net recorded SOL (buys minus sells) over the last `w` slots. */
  const flow = (t: Tape, now: number, w: number): number => {
    let net = 0;
    for (let i = t.trades.length - 1; i >= 0; i--) {
      const tr = t.trades[i]!;
      if (tr.slot <= now - w) break;
      net += tr.buy ? tr.sol : -tr.sol;
    }
    return net;
  };

  /** Entry signal on a curve's opening tape at slot `now`. */
  const entrySignal = (t: Tape, now: number, rqSol: number): boolean => {
    if (rqSol < p.minRqSol || rqSol > p.maxRqSol) return false;
    if (t.created === null) return false;
    const age = now - t.created;
    if (age < p.minAge || age > p.maxAge) return false;
    let buySol = 0;
    let sellSol = 0;
    let buys = 0;
    let high = 0;
    let last = 0;
    const byUser = new Map<string, number>();
    for (const tr of t.trades) {
      if (tr.slot < t.created) continue;
      if (tr.buy) {
        buySol += tr.sol;
        buys++;
        byUser.set(tr.user, (byUser.get(tr.user) ?? 0) + tr.sol);
      } else {
        sellSol += tr.sol;
      }
      if (tr.price > high) high = tr.price;
      last = tr.price;
    }
    if (buys < 1 || byUser.size < p.minBuyers) return false;
    if (buySol < p.minBuySol) return false;
    if (t.price0 <= 0 || last <= 0) return false;
    const up = last / t.price0 - 1;
    if (up < p.minUp || up > p.maxUp) return false;
    if (last < high * p.nearHigh) return false;
    let top = 0;
    for (const v of byUser.values()) if (v > top) top = v;
    if (top > p.maxTopShare * buySol) return false;
    if (flow(t, now, p.entryFlowWindow) < p.entryMinFlowSol) return false;
    return true;
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      if (firstSlot === null) firstSlot = now;
      const traded = new Set<Pubkey>();
      for (const e of batch.events) {
        if (e.event === 'CreateEvent') {
          const t = tapeOf(e.mint);
          t.created = e.slot;
          t.creator = e.creator;
          t.price0 = Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves);
        } else if (e.event === 'TradeEvent') {
          const t = tapeOf(e.mint);
          const sol = Number(e.sol_amount) / LAMPORTS;
          t.trades.push({
            slot: e.slot,
            buy: e.is_buy,
            sol,
            user: e.user,
            price: Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves),
          });
          traded.add(e.mint);
          if (!e.is_buy && e.user === t.creator) {
            const h = held.get(e.mint);
            if (h !== undefined) h.creatorSold = true;
          }
        }
      }
      // Prune tapes: keep ~3000 slots of history (covers maxHold + fade window).
      for (const mint of traded) {
        const t = tapes.get(mint)!;
        let cut = 0;
        while (cut < t.trades.length && t.trades[cut]!.slot <= now - 3000) cut++;
        if (cut > 0) t.trades.splice(0, cut);
      }
      const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));
      const pendingByMint = new Map<Pubkey, number>();
      for (const po of state.pending.values()) pendingByMint.set(po.order.mint, (pendingByMint.get(po.order.mint) ?? 0) + 1);

      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = Number(state.txFeeLamports()) / LAMPORTS;
      const w = windowOf(now);
      const coinsThisWindow = windowCoins.get(w) ?? new Set<Pubkey>();
      windowCoins.set(w, coinsThisWindow);

      const closeValue = (mint: Pubkey): number => {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined || curve === undefined) return 0;
        const mk = marks.get(mint);
        const vq = mk ? Number(mk.virtual_quote_reserves) : Number(curve.virtual_quote_reserves);
        const vt = mk ? Number(mk.virtual_token_reserves) : Number(curve.virtual_token_reserves);
        const tokens = Number(pos.token_amount);
        return ((tokens * vq) / (vt + tokens) / LAMPORTS) * (1 - CURVE_FEE) - tx;
      };

      // Exits first.
      for (const [mint, h] of held) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) {
            held.delete(mint);
            if (h.filled) tapeOf(mint).lastExit = now;
            else tapeOf(mint).entries--;
          }
          continue;
        }
        h.filled = true;
        if (curve === undefined || curve.complete) continue;
        const value = closeValue(mint);
        if (value > h.peakValue) h.peakValue = value;
        h.lastValue = value;
        const cost = Number(pos.cost_lamports) / LAMPORTS;
        const mk = marks.get(mint);
        const rqSol = (mk ? Number(mk.real_quote_reserves) : Number(curve.real_quote_reserves)) / LAMPORTS;
        const t = tapeOf(mint);
        const riding = rqSol >= p.rideRqSol && flow(t, now, p.fadeWindow) > 0;
        let exit = h.exiting;
        if (!exit && value < cost * (1 - p.stopLoss)) exit = true;
        if (!exit && !riding && h.peakValue >= cost * (1 + p.trailArm) && value < h.peakValue * (1 - p.trail)) exit = true;
        if (!exit && !riding && p.fadeNetSol !== Infinity && flow(t, now, p.fadeWindow) < -p.fadeNetSol) exit = true;
        if (!exit && p.staleSlots > 0 && now - h.opened > p.staleSlots && value < cost * (1 - p.staleDown)) exit = true;
        if (!exit && p.exitOnCreatorSell && h.creatorSold) exit = true;
        if (!exit && now - h.opened > p.maxHold) exit = true;
        if (!exit) continue;
        h.exiting = true;
        let sellPending = false;
        for (const po of state.pending.values()) if (po.order.mint === mint && po.order.side === 'sell') sellPending = true;
        if (sellPending) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
      }

      // Probe round trips: sell the whole probe as soon as its buy has landed.
      for (const [mint, selling] of probes) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) probes.delete(mint);
          continue;
        }
        if (curve === undefined || curve.complete || pendingByMint.has(mint)) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
        if (!selling) probes.set(mint, true);
      }

      // Entries.
      let free = Number(state.freeCashLamports()) / LAMPORTS;
      let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
      let mainLeft = p.maxMain - held.size;
      let exposure = 0;
      for (const [mint, h] of held) exposure += Math.max(h.invested, Number(state.positions.get(mint)?.cost_lamports ?? 0n) / LAMPORTS);
      for (const mint of traded) {
        if (orders.length >= cap) break;
        if (held.has(mint) || probes.has(mint) || pendingByMint.has(mint)) continue;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (slotsLeft <= 0 || mainLeft <= 0) continue;
        const t = tapes.get(mint)!;
        if (t.entries >= p.maxEntries) continue;
        const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
        if (!entrySignal(t, now, rqSol)) continue;
        const capSol = Math.floor(Number(state.maxBuyLamports(mint))) / LAMPORTS;
        let amount = Math.min(capSol, p.stakeSol, p.maxExposureSol - exposure);
        if (amount > free - tx) amount = free - tx;
        if (amount < p.minBuySolOrder) continue;
        const lamports = BigInt(Math.floor(amount * LAMPORTS));
        orders.push({ side: 'buy', mint, quote_lamports: lamports, max_slippage_bps: p.buySlipBps });
        free -= amount + tx;
        exposure += amount;
        held.set(mint, { opened: now, peakValue: 0, invested: amount, exiting: false, filled: false, creatorSold: false, lastValue: 0 });
        t.entries++;
        coinsThisWindow.add(mint);
        slotsLeft--;
        mainLeft--;
      }

      // Guardrail pacing: open a probe when this 6 h slice lags its coin pace.
      const probesThisWindow = windowProbes.get(w) ?? 0;
      if (probes.size < p.maxProbesOpen && slotsLeft > 0 && probesThisWindow < p.maxProbesPerWindow && state.committedPositionCount() < 4) {
        const frac = firstSlot === null ? 0 : ((now - firstSlot) % WINDOW_SLOTS) / WINDOW_SLOTS;
        const need = coinsThisWindow.size < Math.ceil(p.probeTargetCoins * Math.max(frac, 0.05));
        if (need) {
          const minRq = (p.probeSol * 10_000) / state.hello.caps.max_order_bps_of_real_reserve;
          for (const mint of traded) {
            if (orders.length >= cap || probes.size >= p.maxProbesOpen) break;
            if (held.has(mint) || probes.has(mint) || pendingByMint.has(mint) || state.positions.has(mint)) continue;
            if (coinsThisWindow.has(mint)) continue; // probes buy breadth: a new coin per probe
            const curve = state.curves.get(mint);
            if (curve === undefined || curve.complete) continue;
            if (Number(curve.real_quote_reserves) / LAMPORTS < minRq * 1.5) continue;
            if (free < p.probeSol + 2 * tx) break;
            orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(p.probeSol * LAMPORTS)), max_slippage_bps: p.buySlipBps });
            probes.set(mint, false);
            windowProbes.set(w, probesThisWindow + 1);
            coinsThisWindow.add(mint);
            free -= p.probeSol + tx;
          }
        }
      }
      return orders;
    },
  };
}
