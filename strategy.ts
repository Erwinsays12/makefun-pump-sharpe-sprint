// Sharpe Sprint — launch-sniper paper bot for the pump.fun replay.
//
// Why this shape: the ranking is hourly Sharpe and a prize needs net PnL above
// zero, so the bot hunts the one asymmetry the bonding curve offers — a coin
// bought near its creation can run many multiples if it migrates, while a coin
// bought after it already ran is usually someone else's exit. The dev data
// says the opening spike is spent within the first two slots (the creator's
// own buy and the first snipers), so this bot does NOT chase it: it waits at
// least 300 slots, then buys only launches that still look clean — the creator
// bought a meaningful stake and has not sold, only a handful of other wallets
// bought in, real SOL reserves are in a sane band, the price has not run away
// from its create price, and it has pulled back from its early high. Every
// position is a small, flat 0.10 SOL ticket, exited mechanically — a wide take
// profit for the rare runner, a stop loss, a trailing stop once it runs, an
// immediate exit when the creator sells, and a hard time limit so capital
// keeps cycling through the ~300 launches of a 6-hour window.
//
// Sizing is flat: 0.10 SOL per coin, at most 5 open positions, no adds — a
// position either runs or it is cut. A pacing guard opens tiny probe round
// trips when fills or distinct coins lag the pace, keeping the run above the
// guardrails (round trips of >= 0.01 SOL on >= 20 distinct mints).
//
// Deterministic by construction: no clock, no randomness, no network; iteration
// only over insertion-ordered maps fed by the batch stream.

import type { Batch, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

const LAMPORTS = 1e9;
const CURVE_FEE = 0.0125; // protocol 95 bps + creator 30 bps fallback, as a share.
const BPS = 10_000;

export interface Params {
  /** Youngest age (slots since create) at which a coin may be bought. */
  minAgeSlots: number;
  /** Oldest age (slots since create) at which a first buy may still be decided. */
  maxAgeSlots: number;
  /** SOL to aim for per coin (each buy still capped at 1% of real SOL). */
  stakeSol: number;
  /** Smallest single buy worth paying the tx fee for (SOL). */
  minBuySol: number;
  /** Real SOL reserve band at decision time. */
  minRealSol: number;
  maxRealSol: number;
  /** Creator's own buys in the create slot: at least this many SOL (skin in the game). */
  minDevBuySol: number;
  /** Creator's own buys in the create slot: at most this many SOL. */
  maxDevBuySol: number;
  /** Distinct non-creator buyers seen before entry, at most. */
  maxBuyers: number;
  /** Price now over the create price, at most (as a multiple). */
  maxRunup: number;
  /** Buy only when the price has pulled back to at most this share of the
   *  highest trade price seen since creation (1 = no pullback required). */
  maxPullback: number;
  /** Creator sold before entry: skip the coin. */
  skipDevSold: boolean;
  /** Slippage allowed on buys (bps). */
  buySlipBps: number;
  /** Exit when the position is worth this much over its cost. */
  takeProfit: number;
  /** Exit when it is worth this much under its cost. */
  stopLoss: number;
  /** Trailing stop: once up at least this much, exit on a fall of this much from the best value. */
  trailArm: number;
  trailDrop: number;
  /** Exit after holding this many slots. */
  maxHoldSlots: number;
  /** Exit when the creator sells while held. */
  exitOnDevSell: boolean;
  /** Exit when net SOL over this window (slots) falls below exitFlowSol. */
  fadeWindow: number;
  exitFlowSol: number;
  /** Guardrail pacing. */
  targetCoins: number;
  targetFills: number;
  paceSeconds: number;
  probeSol: number;
  maxProbes: number;
}

export const DEFAULT_PARAMS: Params = {
  minAgeSlots: 300,
  maxAgeSlots: 10_000,
  stakeSol: 0.1,
  minBuySol: 0.01,
  minRealSol: 0.3,
  maxRealSol: 30,
  minDevBuySol: 0.5,
  maxDevBuySol: 2.5,
  maxBuyers: 4,
  maxRunup: 2,
  maxPullback: 0.85,
  skipDevSold: true,
  buySlipBps: 10_000,
  takeProfit: 1.0,
  stopLoss: 0.25,
  trailArm: 0.5,
  trailDrop: 0.25,
  maxHoldSlots: 5000,
  exitOnDevSell: true,
  fadeWindow: 30,
  exitFlowSol: -1_000_000,
  targetCoins: 30,
  targetFills: 300,
  paceSeconds: 21_600,
  probeSol: 0.02,
  maxProbes: 1,
};

interface LaunchTrade {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
}

/** Everything watched about one launch, from its CreateEvent on. */
interface Launch {
  mint: Pubkey;
  creator: Pubkey;
  createSlot: number;
  createVq: bigint;
  createVt: bigint;
  devBuySol: number;
  devSold: boolean;
  buyers: Set<Pubkey>;
  boughtSol: number;
  soldByOthersSol: number;
  lastTradeSlot: number;
  recent: LaunchTrade[];
  /** Highest trade price seen since creation (SOL per token). */
  highPrice: number;
  /** Never buy it again (exited, filtered out for good, or completed). */
  done: boolean;
  complete: boolean;
}

interface OpenPosition {
  openedSlot: number;
  peakValueSol: number;
  devSoldAtOpen: boolean;
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

/** Net SOL (buys minus sells) recorded on a launch over the last `w` slots. */
function netFlow(launch: Launch, now: number, w: number): number {
  let net = 0;
  for (let i = launch.recent.length - 1; i >= 0; i--) {
    const tr = launch.recent[i]!;
    if (tr.slot <= now - w) break;
    net += tr.buy ? tr.sol : -tr.sol;
  }
  return net;
}

export function createBot(p: Params = DEFAULT_PARAMS) {
  const launches = new Map<Pubkey, Launch>();
  const open = new Map<Pubkey, OpenPosition>();
  const probes = new Map<Pubkey, boolean>(); // mint -> true once its sell is queued
  const selling = new Set<Pubkey>(); // mints with a sell in flight
  let myFills = 0;
  const myCoins = new Set<Pubkey>();
  let firstBlockTime: number | null = null;
  let lastBlockTime: number | null = null;

  const launchOf = (mint: Pubkey): Launch | undefined => launches.get(mint);

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      for (const e of batch.events) {
        if (e.block_time !== null) {
          if (firstBlockTime === null) firstBlockTime = e.block_time;
          if (lastBlockTime === null || e.block_time > lastBlockTime) lastBlockTime = e.block_time;
        }
        if (e.event === 'CreateEvent') {
          launches.set(e.mint, {
            mint: e.mint,
            creator: e.creator,
            createSlot: e.slot,
            createVq: BigInt(e.virtual_quote_reserves),
            createVt: BigInt(e.virtual_token_reserves),
            devBuySol: 0,
            devSold: false,
            buyers: new Set(),
            boughtSol: 0,
            soldByOthersSol: 0,
            lastTradeSlot: e.slot,
            recent: [],
            highPrice: priceOf(e.virtual_quote_reserves, e.virtual_token_reserves),
            done: false,
            complete: false,
          });
        } else if (e.event === 'TradeEvent') {
          const l = launches.get(e.mint);
          if (l === undefined) continue;
          const sol = Number(e.sol_amount) / LAMPORTS;
          l.lastTradeSlot = e.slot;
          l.recent.push({ slot: e.slot, buy: e.is_buy, sol, user: e.user });
          const tradePrice = priceOf(e.virtual_quote_reserves, e.virtual_token_reserves);
          if (tradePrice > l.highPrice) l.highPrice = tradePrice;
          const isDev = e.user === l.creator;
          if (e.is_buy) {
            l.boughtSol += sol;
            if (isDev && e.slot === l.createSlot) l.devBuySol += sol;
            else if (!isDev) l.buyers.add(e.user);
          } else if (isDev) {
            l.devSold = true;
          } else {
            l.soldByOthersSol += sol;
          }
        } else {
          const l = launches.get(e.mint);
          if (l !== undefined) {
            l.complete = true;
            l.done = true;
          }
        }
      }
      for (const f of batch.fills) {
        if (f.status === 'filled' && !f.client_id.startsWith('_')) {
          myFills++;
          myCoins.add(f.mint);
        }
        if (f.client_id.startsWith('_')) {
          open.delete(f.mint);
          selling.delete(f.mint);
        }
      }
      for (const mint of [...selling]) {
        let stillPending = false;
        for (const po of state.pending.values()) {
          if (po.order.mint === mint && po.order.side === 'sell') {
            stillPending = true;
            break;
          }
        }
        if (!stillPending) selling.delete(mint);
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

      // --- Exits first: take profit, stop loss, trailing stop, creator sell, fade, time. ---
      for (const [mint, held] of state.positions) {
        if (orders.length >= orderCap) break;
        if (selling.has(mint)) continue;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        let pos = open.get(mint);
        if (pos === undefined) {
          pos = { openedSlot: now, peakValueSol: 0, devSoldAtOpen: launchOf(mint)?.devSold ?? false };
          open.set(mint, pos);
        }
        const value = sellValueSol(held.token_amount, curve.virtual_quote_reserves, curve.virtual_token_reserves, txFeeSol);
        const cost = Number(held.cost_lamports) / LAMPORTS;
        if (value > pos.peakValueSol) pos.peakValueSol = value;
        const launch = launchOf(mint);
        let exit = false;
        if (value >= cost * (1 + p.takeProfit)) exit = true;
        if (value <= cost * (1 - p.stopLoss)) exit = true;
        if (pos.peakValueSol >= cost * (1 + p.trailArm) && value <= pos.peakValueSol * (1 - p.trailDrop)) exit = true;
        if (launch !== undefined) {
          if (p.exitOnDevSell && launch.devSold && !pos.devSoldAtOpen) exit = true;
          if (netFlow(launch, now, p.fadeWindow) < p.exitFlowSol) exit = true;
        }
        if (now - pos.openedSlot >= p.maxHoldSlots) exit = true;
        if (!exit) continue;
        orders.push({ side: 'sell', mint, token_amount: held.token_amount, max_slippage_bps: BPS });
        selling.add(mint);
        if (launch !== undefined) launch.done = true;
      }

      // --- Probe sells: a probe round trip sells everything as soon as its buy lands. ---
      for (const [mint, sold] of probes) {
        const held = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (held === undefined) {
          if (!pendingByMint.has(mint)) probes.delete(mint);
          continue;
        }
        if (curve === undefined || curve.complete || pendingByMint.has(mint)) continue;
        if (orders.length >= orderCap) break;
        orders.push({ side: 'sell', mint, token_amount: held.token_amount, max_slippage_bps: BPS });
        if (!sold) probes.set(mint, true);
      }

      // --- Entries: launches in their first slots that pass the rug screen. ---
      let freeSol = Number(state.freeCashLamports()) / LAMPORTS;
      let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
      for (const launch of launches.values()) {
        if (orders.length >= orderCap) break;
        if (launch.done || launch.complete) continue;
        const age = now - launch.createSlot;
        if (age > p.maxAgeSlots) {
          launch.done = true;
          continue;
        }
        if (age < p.minAgeSlots) continue;
        if (slotsLeft <= 0) continue;
        if (state.positions.has(launch.mint) || probes.has(launch.mint) || pendingByMint.has(launch.mint)) continue;
        const curve = state.curves.get(launch.mint);
        if (curve === undefined || curve.complete) continue;
        // Rug screen.
        const realSol = Number(curve.real_quote_reserves) / LAMPORTS;
        if (realSol < p.minRealSol || realSol > p.maxRealSol) continue;
        if (launch.devBuySol < p.minDevBuySol || launch.devBuySol > p.maxDevBuySol) continue;
        if (launch.buyers.size > p.maxBuyers) continue;
        if (p.skipDevSold && launch.devSold) {
          launch.done = true;
          continue;
        }
        const nowPrice = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
        const runup = nowPrice / priceOf(launch.createVq, launch.createVt);
        if (!(runup <= p.maxRunup)) continue;
        if (nowPrice > launch.highPrice * p.maxPullback) continue;
        const capSol = Math.floor(Number(state.maxBuyLamports(launch.mint))) / LAMPORTS;
        const amountSol = Math.min(capSol, p.stakeSol);
        if (amountSol < p.minBuySol) continue;
        if (freeSol < amountSol + txFeeSol) continue;
        orders.push({ side: 'buy', mint: launch.mint, quote_lamports: BigInt(Math.floor(amountSol * LAMPORTS)), max_slippage_bps: p.buySlipBps });
        freeSol -= amountSol + txFeeSol;
        slotsLeft--;
        open.set(launch.mint, { openedSlot: now, peakValueSol: 0, devSoldAtOpen: launch.devSold });
        launch.done = true;
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
          for (const e of batch.events) {
            if (orders.length >= orderCap || probes.size >= p.maxProbes) break;
            if (e.event !== 'TradeEvent') continue;
            const mint = e.mint;
            if (open.has(mint) || probes.has(mint) || pendingByMint.has(mint) || state.positions.has(mint)) continue;
            const launch = launchOf(mint);
            if (launch !== undefined && launch.done) continue;
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
