// Sharpe Sprint — a diversified quick-flip paper bot for the pump.fun replay.
//
// Idea: the ranking is hourly Sharpe, not raw PnL, so the bot optimises for a smooth
// equity curve: many small, diversified round trips, quick profit-taking, tight stops,
// and no hero trades. Every position is small (<= 0.35 SOL of a 10 SOL bankroll), exits
// are mechanical, and a pacing guard keeps the run above the guardrails (round trips of
// >= 0.01 SOL on >= 20 distinct mints) even on a quiet window.
//
// Entry: a curve whose recent tape shows broad, accelerating buy pressure — several
// distinct buyers, net SOL flowing in, price up but not parabolic and sitting near its
// recent high — and whose real SOL reserves are large enough that the 1%-of-reserve
// size cap still allows a meaningful buy. One small first buy; at most one add while
// the position is up and inflow continues.
//
// Exit: take profit at +15%, stop loss at -10%, a trailing stop once the position is
// up 6%, a fade exit when the short-window flow turns negative, or a time limit.
//
// Deterministic by construction: no clock, no randomness, no network; iteration only
// over insertion-ordered maps fed by the batch stream. The only state is the tapes,
// the open positions and the pacing counters below.

import { LAMPORTS_PER_SOL, runBot, type Batch, type BotState, type OrderInput, type Pubkey } from './vendor/makefun-bot.ts';

const LAMPORTS = 1e9;
const CURVE_FEE = 0.0125; // protocol 95 bps + creator 30 bps fallback, as a share.
const BPS = 10_000;

export interface Params {
  // Entry window (slots) and the tape conditions a curve must meet.
  window: number;
  minNetSol: number;
  minBuys: number;
  minBuyers: number;
  minPriceUp: number;
  maxPriceUp: number;
  nearHigh: number;
  maxBuyerShare: number;
  minRealSol: number;
  maxRealSol: number;
  minAgeSlots: number;
  // Sizing (SOL).
  firstBuySol: number;
  addBuySol: number;
  maxPerCoinSol: number;
  minBuySol: number;
  maxExposureSol: number;
  // Slippage (bps).
  buySlipBps: number;
  // Exits.
  takeProfit: number;
  stopLoss: number;
  trailArm: number;
  trailDrop: number;
  fadeWindow: number;
  fadeNetSol: number;
  maxHoldSlots: number;
  holdIfUp: number;
  // Re-entry.
  cooldownSlots: number;
  maxEntriesPerCoin: number;
  // Guardrail pacing.
  targetCoins: number;
  targetFills: number;
  paceSeconds: number;
  probeSol: number;
  maxProbes: number;
}

export const DEFAULT_PARAMS: Params = {
  window: 60,
  minNetSol: 0.8,
  minBuys: 5,
  minBuyers: 4,
  minPriceUp: 0.04,
  maxPriceUp: 1.2,
  nearHigh: 0.92,
  maxBuyerShare: 0.6,
  minRealSol: 2,
  maxRealSol: 70,
  minAgeSlots: 240,
  firstBuySol: 0.25,
  addBuySol: 0.1,
  maxPerCoinSol: 0.35,
  minBuySol: 0.01,
  maxExposureSol: 8,
  buySlipBps: 2000,
  takeProfit: 0.15,
  stopLoss: 0.1,
  trailArm: 0.06,
  trailDrop: 0.06,
  fadeWindow: 30,
  fadeNetSol: -0.5,
  maxHoldSlots: 1800,
  holdIfUp: 0.1,
  cooldownSlots: 300,
  maxEntriesPerCoin: 2,
  targetCoins: 30,
  targetFills: 300,
  paceSeconds: 21_600,
  probeSol: 0.02,
  maxProbes: 1,
};

interface TapeTrade {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
  price: number;
}

interface Tape {
  createdSlot: number | null;
  trades: TapeTrade[];
  entries: number;
  lastExitSlot: number;
}

interface OpenPosition {
  openedSlot: number;
  peakValueSol: number;
  investedSol: number;
  adds: number;
  exiting: boolean;
  filled: boolean;
  lastAddPrice: number;
  lastValueSol: number;
}

/** Price of one token in SOL from virtual reserves (SOL per token). */
function priceOf(vq: bigint, vt: bigint): number {
  if (vt === 0n) return 0;
  return Number(vq) / Number(vt);
}

/**
 * What selling `tokens` would net, in SOL, after the curve fee and one transaction
 * fee: the constant-product quote minus fees. Mirrors the replay's sell math.
 */
function sellValueSol(tokens: bigint, vq: bigint, vt: bigint, txFeeSol: number): number {
  const t = Number(tokens);
  if (t <= 0 || vt === 0n) return 0;
  const quote = (t * Number(vq)) / (Number(vt) + t) / LAMPORTS;
  return quote * (1 - CURVE_FEE) - txFeeSol;
}

/** Net SOL (buys minus sells) recorded on a tape over the last `w` slots. */
function netFlow(tape: Tape, now: number, w: number): number {
  let net = 0;
  for (let i = tape.trades.length - 1; i >= 0; i--) {
    const tr = tape.trades[i]!;
    if (tr.slot <= now - w) break;
    net += tr.buy ? tr.sol : -tr.sol;
  }
  return net;
}

export function createBot(p: Params = DEFAULT_PARAMS) {
  const tapes = new Map<Pubkey, Tape>();
  const open = new Map<Pubkey, OpenPosition>();
  const probes = new Map<Pubkey, boolean>(); // mint -> true once its sell is queued
  let myFills = 0;
  const myCoins = new Set<Pubkey>();
  let firstBlockTime: number | null = null;
  let lastBlockTime: number | null = null;
  const keepSlots = p.window + 10;

  const tapeOf = (mint: Pubkey): Tape => {
    let t = tapes.get(mint);
    if (t === undefined) {
      t = { createdSlot: null, trades: [], entries: 0, lastExitSlot: -1e12 };
      tapes.set(mint, t);
    }
    return t;
  };

  /** True when a curve's recent tape shows broad, still-accelerating buy pressure. */
  const entrySignal = (tape: Tape, now: number, realSol: number): boolean => {
    if (realSol < p.minRealSol || realSol > p.maxRealSol) return false;
    if (tape.createdSlot === null || now - tape.createdSlot < p.minAgeSlots) return false;
    const from = now - p.window;
    const mid = now - p.window / 2;
    let buySol = 0;
    let sellSol = 0;
    let buys = 0;
    let netOld = 0;
    let netNew = 0;
    let startPrice = -1;
    let high = 0;
    let last = 0;
    const byUser = new Map<string, number>();
    for (const tr of tape.trades) {
      if (tr.slot <= from) {
        startPrice = tr.price;
        continue;
      }
      if (startPrice < 0) startPrice = tr.price;
      const signed = tr.buy ? tr.sol : -tr.sol;
      if (tr.slot <= mid) netOld += signed;
      else netNew += signed;
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
    if (buys < p.minBuys || byUser.size < p.minBuyers) return false;
    if (buySol - sellSol < p.minNetSol) return false;
    if (startPrice <= 0 || last <= 0) return false;
    const up = last / startPrice - 1;
    if (up < p.minPriceUp || up > p.maxPriceUp) return false;
    if (last < high * p.nearHigh) return false;
    // Acceleration: the newer half of the window must carry at least as much net
    // inflow as the older half, and must be positive on its own.
    if (netNew <= 0 || netNew < netOld) return false;
    let top = 0;
    for (const v of byUser.values()) if (v > top) top = v;
    if (top > p.maxBuyerShare * buySol) return false;
    return true;
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      const traded = new Set<Pubkey>();
      for (const f of batch.fills) {
        if (f.status === 'filled' && !f.client_id.startsWith('_')) {
          myFills++;
          myCoins.add(f.mint);
        }
      }
      for (const e of batch.events) {
        if (e.block_time !== null) {
          if (firstBlockTime === null) firstBlockTime = e.block_time;
          if (lastBlockTime === null || e.block_time > lastBlockTime) lastBlockTime = e.block_time;
        }
        if (e.event === 'CreateEvent') {
          tapeOf(e.mint).createdSlot = e.slot;
        } else if (e.event === 'TradeEvent') {
          const tape = tapeOf(e.mint);
          tape.trades.push({
            slot: e.slot,
            buy: e.is_buy,
            sol: Number(e.sol_amount) / LAMPORTS,
            user: e.user,
            price: priceOf(e.virtual_quote_reserves, e.virtual_token_reserves),
          });
          traded.add(e.mint);
        }
      }
      for (const mint of traded) {
        const tape = tapes.get(mint)!;
        let cut = 0;
        while (cut < tape.trades.length && tape.trades[cut]!.slot <= now - keepSlots) cut++;
        if (cut > 0) tape.trades.splice(0, cut);
      }

      const orders: OrderInput[] = [];
      const orderCap = state.hello.caps.max_orders_per_batch;
      const txFeeSol = Number(state.txFeeLamports()) / LAMPORTS;
      const pendingByMint = new Map<Pubkey, { buy: boolean; sell: boolean }>();
      for (const po of state.pending.values()) {
        const rec = pendingByMint.get(po.order.mint) ?? { buy: false, sell: false };
        if (po.order.side === 'buy') rec.buy = true;
        else rec.sell = true;
        pendingByMint.set(po.order.mint, rec);
      }

      // --- Exits first: take profit, stop loss, trailing stop, fade, time limit. ---
      for (const [mint, pos] of open) {
        const held = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (held === undefined) {
          if (!pendingByMint.has(mint)) {
            open.delete(mint);
            if (pos.filled) tapeOf(mint).lastExitSlot = now;
            else tapeOf(mint).entries--;
          }
          continue;
        }
        pos.filled = true;
        if (curve === undefined || curve.complete) continue;
        const value = sellValueSol(held.token_amount, curve.virtual_quote_reserves, curve.virtual_token_reserves, txFeeSol);
        const cost = Number(held.cost_lamports) / LAMPORTS;
        if (value > pos.peakValueSol) pos.peakValueSol = value;
        pos.lastValueSol = value;
        let exit = pos.exiting;
        const tape = tapeOf(mint);
        if (!exit && value >= cost * (1 + p.takeProfit)) exit = true;
        if (!exit && value <= cost * (1 - p.stopLoss)) exit = true;
        if (!exit && pos.peakValueSol >= cost * (1 + p.trailArm) && value <= pos.peakValueSol * (1 - p.trailDrop)) exit = true;
        if (!exit && netFlow(tape, now, p.fadeWindow) < p.fadeNetSol) exit = true;
        if (!exit && now - pos.openedSlot > p.maxHoldSlots && value < cost * (1 + p.holdIfUp)) exit = true;
        if (!exit) continue;
        pos.exiting = true;
        if (pendingByMint.get(mint)?.sell) continue;
        if (orders.length >= orderCap) break;
        orders.push({ side: 'sell', mint, token_amount: held.token_amount, max_slippage_bps: BPS });
      }

      // --- Probe sells: a probe round trip sells everything as soon as its buy lands. ---
      for (const [mint, selling] of probes) {
        const held = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (held === undefined) {
          if (!pendingByMint.has(mint)) probes.delete(mint);
          continue;
        }
        if (curve === undefined || curve.complete || pendingByMint.has(mint)) continue;
        if (orders.length >= orderCap) break;
        orders.push({ side: 'sell', mint, token_amount: held.token_amount, max_slippage_bps: BPS });
        if (!selling) probes.set(mint, true);
      }

      // --- Entries and one pyramid add per position. ---
      let freeSol = Number(state.freeCashLamports()) / LAMPORTS;
      let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
      let exposureSol = 0;
      for (const [mint, pos] of open) {
        exposureSol += Math.max(pos.investedSol, Number(state.positions.get(mint)?.cost_lamports ?? 0n) / LAMPORTS);
      }
      for (const mint of traded) {
        if (orders.length >= orderCap) break;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (pendingByMint.has(mint) || probes.has(mint)) continue;
        const tape = tapes.get(mint)!;
        const pos = open.get(mint);
        const price = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
        const realSol = Number(curve.real_quote_reserves) / LAMPORTS;
        let wantSol: number;
        if (pos === undefined) {
          if (slotsLeft <= 0) continue;
          if (tape.entries >= p.maxEntriesPerCoin || now - tape.lastExitSlot < p.cooldownSlots) continue;
          if (!entrySignal(tape, now, realSol)) continue;
          wantSol = p.firstBuySol;
        } else {
          // Pyramid once, into strength only: the position is up, the price stepped
          // up from the last add, and net SOL is still flowing in.
          if (pos.exiting || !pos.filled || pos.adds >= 1 || pos.investedSol >= p.maxPerCoinSol - p.minBuySol) continue;
          const held = state.positions.get(mint);
          if (held === undefined) continue;
          if (price < pos.lastAddPrice * 1.02) continue;
          if (pos.lastValueSol < Number(held.cost_lamports) / LAMPORTS * 1.03) continue;
          if (netFlow(tape, now, p.window) < p.minNetSol) continue;
          if (realSol > p.maxRealSol) continue;
          wantSol = Math.min(p.addBuySol, p.maxPerCoinSol - pos.investedSol);
        }
        const capSol = Math.floor(Number(state.maxBuyLamports(mint))) / LAMPORTS;
        let amountSol = Math.min(capSol, wantSol, p.maxExposureSol - exposureSol);
        if (amountSol > freeSol - txFeeSol) amountSol = freeSol - txFeeSol;
        if (amountSol < p.minBuySol) continue;
        const lamports = BigInt(Math.floor(amountSol * LAMPORTS));
        orders.push({ side: 'buy', mint, quote_lamports: lamports, max_slippage_bps: p.buySlipBps });
        freeSol -= amountSol + txFeeSol;
        exposureSol += amountSol;
        if (pos === undefined) {
          open.set(mint, {
            openedSlot: now,
            peakValueSol: 0,
            investedSol: amountSol,
            adds: 0,
            exiting: false,
            filled: false,
            lastAddPrice: price,
            lastValueSol: 0,
          });
          tape.entries++;
          slotsLeft--;
        } else {
          pos.investedSol += amountSol;
          pos.adds++;
          pos.lastAddPrice = price;
        }
      }

      // --- Guardrail pacing: keep fills and distinct coins on pace. ---
      // The run must end with round trips on >= 20 coins; when my own fills or coins
      // lag the pace (scaled by the share of paceSeconds elapsed in block time), open
      // a tiny probe round trip on a liquid curve and sell it as soon as it lands.
      if (probes.size < p.maxProbes && slotsLeft > 0 && firstBlockTime !== null && lastBlockTime !== null) {
        const pace = Math.min(1, (lastBlockTime - firstBlockTime) / p.paceSeconds);
        const needCoins = myCoins.size < Math.ceil(p.targetCoins * pace);
        const needFills = myFills < Math.ceil(p.targetFills * pace);
        if (needCoins || needFills) {
          const minReal = (p.probeSol * BPS) / state.hello.caps.max_order_bps_of_real_reserve;
          for (const mint of traded) {
            if (orders.length >= orderCap || probes.size >= p.maxProbes) break;
            if (open.has(mint) || probes.has(mint) || pendingByMint.has(mint) || state.positions.has(mint)) continue;
            if (needCoins && !needFills && myCoins.has(mint)) continue;
            const curve = state.curves.get(mint);
            if (curve === undefined || curve.complete) continue;
            if (Number(curve.real_quote_reserves) / LAMPORTS < minReal * 1.5) continue;
            if (freeSol < p.probeSol + 2 * txFeeSol) break;
            orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(p.probeSol * LAMPORTS)), max_slippage_bps: p.buySlipBps });
            probes.set(mint, false);
            freeSol -= p.probeSol + txFeeSol;
          }
        }
      }

      return orders;
    },
  };
}

await runBot(createBot());
