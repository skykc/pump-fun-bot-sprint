// Pump.fun replay bot — "Slow-Starter Sniper"
// Protocol: agent-fun/replay/v2 (NDJSON on stdin: hello, batch, done;
// bot replies once per batch with {type:"reply", seq, orders}).
//
// Strategy, from the dev replay (kit dataset, 24h, 1,222 mints):
// - The first trade of a coin lands in the same slot as its creation
//   (98.8%) and the fill 2 slots later already costs +18% median.
//   Chasing the first pump therefore buys the top: fast pumpers lose.
// - Slow starters win the least-bad: coins whose price is only +2% to
//   +12% above their first price, with buy-dominated flow and a clean
//   creator (no creator sell in the early trades), grind up instead of
//   spiking and dumping. Distinct-buyer breadth (>=4 buyers by trade 5)
//   and a clean creator both lift the median 30-minute max return a lot
//   (creator-clean +59% vs creator-sold +24%; >=4 buyers +52% vs <4 +12%),
//   so the bot adds to a probe only once a coin proves itself.
// - One trade per coin, no re-entry after an exit. Exits are wide on
//   purpose: take profit +25% vs average entry, a 20% trail from the
//   peak (never a tight stop), a hard stop -12% vs average entry, a
//   time-stop at 4,500 slots, and an immediate sell on CompleteEvent.
//   Open positions are swept for the time-stop on EVERY batch, because
//   a dead coin stops sending events and its slot must still be freed.
// - Sizing: 0.05 SOL per buy (well above the 0.01 SOL round-trip bar),
//   capped at the harness max order (bps of real reserve) and by cash.
//   At most 5 open positions, at most 16 orders per batch.
// - Fills are authoritative: the harness account snapshot and the
//   fills array decide what we hold and what our average entry is.
//   A buy or sell that is rejected leaves the position state untouched
//   so the next batch can retry it; only a filled sell closes a trade.
// - Fully deterministic: no clock, no randomness; client ids are a
//   sequential counter, maps iterate in insertion order, so two runs
//   produce byte-identical action logs.
import * as readline from "node:readline";

// ---- config (all in lamports / fractions, tuned on the dev replay) ----
const PROBE_LAMPORTS = 50_000_000; // 0.05 SOL per buy
const MIN_BUY_LAMPORTS = 10_000_000; // 0.01 SOL guardrail floor
const ENTRY_MIN_RISE = 0.01; // +1% vs first price (catch the slowest grinds too,
// widening the candidate pool so the 6-hour final window still clears
// the 20-coin round-trip bar)
const ENTRY_MAX_RISE = 0.08; // +8% vs first price (slow starters only).
// Grade-local on the dev replay: +8% is the PnL-best cap (-0.067 SOL,
// 97 round trips, DD 0.9%); +9% drops to -0.121 and +10% to -0.106,
// +12% to -0.173. Fast pumpers that already ran in their first trades
// keep dumping after you buy, so the cap stays tight even though it
// costs round trips (97/24h ≈ 24 per 6h final window, above the 20 bar).
const ENTRY_MAX_TRADES = 15; // coin must still be young (wider net, same cap)
const ENTRY_MAX_SLOTS = 1800; // ...and young in slots too
const ENTRY_MIN_BUY_SHARE = 0.6; // buy-dominated early flow
const ADD_TRADE = 5; // pyramid add evaluated at the 5th trade
const ADD_MIN_BUYERS = 4; // distinct buyers by trade 5
const TAKE_PROFIT = 0.25; // +25% vs average entry
const TRAIL = 0.2; // sell 20% below the peak since entry (wide trail)
const HARD_STOP = 0.12; // -12% vs average entry (hard stop)
const MAX_HOLD_SLOTS = 3000; // time-stop (shorter hold frees slots faster,
// so more slow starters get their one trade each in a 6-hour window)
const MAX_SLIPPAGE_BPS = 1000; // allow fills up to +10% past the decision price:
// the 2-slot latency already moves fast coins more than 3%, so a 300 bps
// cap rejects one order in eight outright (55 rejected on the dev run);
// filling them is worth more than the extra slippage on this tape.

type Coin = {
  mint: string;
  firstPrice: number;
  firstSlot: number;
  trades: number;
  buyVol: bigint;
  sellVol: bigint;
  buyers: Set<string>;
  creator: string;
  creatorSold: boolean;
  peak: number;
  // position tracking (mirrors the harness account)
  tokens: bigint;
  cost: bigint;
  avgEntry: number; // SOL per token, volume-weighted from fills
  peakSinceEntry: number;
  buySlot: number;
  stage: number; // 0 = flat, 1 = probe filled, 2 = added once
};

const coins = new Map<string, Coin>();
const traded = new Set<string>(); // one completed trade per mint, no re-entry
const pendingBuy = new Set<string>();
const pendingSell = new Set<string>();
let orderCounter = 0;
let capitalLamports = 10_000_000_000n;
let maxOpenPositions = 5;
let maxOrderBps = 100; // of real reserve
let maxOrdersPerBatch = 16;

function priceOf(vsol: string, vtok: string): number {
  const s = Number(BigInt(vsol));
  const t = Number(BigInt(vtok));
  return t > 0 ? s / t : 0;
}

function getCoin(mint: string, price: number, slot: number, creator: string): Coin {
  let c = coins.get(mint);
  if (!c) {
    c = {
      mint,
      firstPrice: price,
      firstSlot: slot,
      trades: 0,
      buyVol: 0n,
      sellVol: 0n,
      buyers: new Set(),
      creator,
      creatorSold: false,
      peak: price,
      tokens: 0n,
      cost: 0n,
      avgEntry: 0,
      peakSinceEntry: 0,
      buySlot: 0,
      stage: 0,
    };
    coins.set(mint, c);
  }
  return c;
}

function openCount(): number {
  let n = pendingBuy.size;
  for (const c of coins.values()) if (c.stage > 0) n++;
  return n;
}

function buySize(realSolReserves: bigint, cash: bigint): bigint {
  const capByReserve = (realSolReserves * BigInt(maxOrderBps)) / 10000n;
  let amt = BigInt(PROBE_LAMPORTS);
  if (amt > capByReserve) amt = capByReserve;
  if (amt > cash) amt = cash;
  return amt;
}

function main(): void {
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  let cash = capitalLamports;
  const held = new Map<string, { tokens: bigint; cost: bigint }>();

  rl.on("line", (line: string) => {
    if (!line.trim()) return;
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.type === "hello") {
      capitalLamports = BigInt(msg.capital?.lamports ?? "10000000000");
      cash = capitalLamports;
      maxOpenPositions = msg.caps?.max_open_positions ?? 5;
      maxOrderBps = msg.caps?.max_order_bps_of_real_reserve ?? 100;
      maxOrdersPerBatch = msg.caps?.max_orders_per_batch ?? 16;
      return;
    }
    if (msg.type === "done") {
      rl.close();
      process.exit(0);
    }
    if (msg.type !== "batch") return;

    const seq: number = msg.seq;
    const slot: number = msg.slot;
    const orders: any[] = [];

    // Authoritative account snapshot from the harness.
    if (msg.account) {
      cash = BigInt(msg.account.cash_lamports ?? "0");
      held.clear();
      for (const p of msg.account.positions ?? []) {
        held.set(p.mint, { tokens: BigInt(p.token_amount), cost: BigInt(p.cost_lamports) });
      }
    }

    // Fills are authoritative: only a filled buy opens (or adds to) a
    // position, only a filled sell closes one. Rejected fills just clear
    // the pending flag so the next batch can retry.
    for (const f of msg.fills ?? []) {
      const c = coins.get(f.mint);
      if (!c) continue;
      if (f.side === "buy") {
        pendingBuy.delete(f.mint);
        if (f.status !== "filled") continue;
        const quote = BigInt(f.quote_lamports);
        const toks = BigInt(f.token_amount);
        const price = toks > 0n ? Number(quote) / Number(toks) : c.avgEntry;
        if (c.stage === 0) {
          c.avgEntry = price;
          c.peakSinceEntry = price;
          c.buySlot = f.slot;
          c.stage = 1;
          c.tokens = toks;
          c.cost = quote;
        } else {
          const newCost = c.cost + quote;
          const newToks = c.tokens + toks;
          c.avgEntry = newToks > 0n ? Number(newCost) / Number(newToks) : price;
          c.cost = newCost;
          c.tokens = newToks;
          c.peakSinceEntry = Math.max(c.peakSinceEntry, price);
          c.stage = 2;
        }
        traded.add(f.mint);
      } else {
        pendingSell.delete(f.mint);
        if (f.status !== "filled") continue;
        c.stage = 0;
        c.tokens = 0n;
        c.cost = 0n;
        traded.add(f.mint);
      }
    }

    // Process events in order.
    for (const ev of msg.events ?? []) {
      const mint: string = ev.mint;
      if (ev.event === "CreateEvent") {
        const p = priceOf(ev.virtual_sol_reserves, ev.virtual_token_reserves);
        const c = getCoin(mint, p, slot, ev.creator ?? "");
        if (p > c.peak) c.peak = p;
        continue;
      }
      if (ev.event === "CompleteEvent") {
        const c = coins.get(mint);
        if (c && c.stage > 0 && !pendingSell.has(mint) && held.has(mint)) {
          const h = held.get(mint)!;
          if (h.tokens > 0n && orders.length < maxOrdersPerBatch) {
            orders.push({
              side: "sell",
              client_id: `s${++orderCounter}`,
              mint,
              token_amount: h.tokens.toString(),
              max_slippage_bps: MAX_SLIPPAGE_BPS,
            });
            pendingSell.add(mint);
          }
        }
        continue;
      }
      if (ev.event !== "TradeEvent") continue;
      const p = priceOf(ev.virtual_sol_reserves, ev.virtual_token_reserves);
      const c = getCoin(mint, p, slot, ev.creator ?? "");
      c.trades += 1;
      if (p > c.peak) c.peak = p;
      if (ev.is_buy) {
        c.buyVol += BigInt(ev.sol_amount);
        c.buyers.add(ev.user);
      } else {
        c.sellVol += BigInt(ev.sol_amount);
        if (ev.user === c.creator && c.creator !== "") c.creatorSold = true;
      }
      const realSol = BigInt(ev.real_sol_reserves);

      // --- entry: slow starter, young, buy-dominated, clean creator ---
      if (
        c.stage === 0 &&
        !traded.has(mint) &&
        !pendingBuy.has(mint) &&
        openCount() < maxOpenPositions &&
        c.trades <= ENTRY_MAX_TRADES &&
        slot - c.firstSlot <= ENTRY_MAX_SLOTS &&
        c.firstPrice > 0 &&
        p >= c.firstPrice * (1 + ENTRY_MIN_RISE) &&
        p <= c.firstPrice * (1 + ENTRY_MAX_RISE) &&
        !c.creatorSold
      ) {
        const vol = c.buyVol + c.sellVol;
        const buyShare = vol > 0n ? Number(c.buyVol) / Number(vol) : 0;
        if (buyShare >= ENTRY_MIN_BUY_SHARE && orders.length < maxOrdersPerBatch) {
          const amt = buySize(realSol, cash);
          if (amt >= BigInt(MIN_BUY_LAMPORTS)) {
            orders.push({
              side: "buy",
              client_id: `b${++orderCounter}`,
              mint,
              quote_lamports: amt.toString(),
              max_slippage_bps: MAX_SLIPPAGE_BPS,
            });
            pendingBuy.add(mint);
          }
        }
      }

      // --- pyramid add at trade 5: proven coin only ---
      if (
        c.stage > 0 &&
        !pendingBuy.has(mint) &&
        c.trades === ADD_TRADE &&
        !c.creatorSold &&
        c.buyers.size >= ADD_MIN_BUYERS &&
        p >= c.avgEntry &&
        orders.length < maxOrdersPerBatch
      ) {
        const amt = buySize(realSol, cash);
        if (amt >= BigInt(MIN_BUY_LAMPORTS)) {
          orders.push({
            side: "buy",
            client_id: `b${++orderCounter}`,
            mint,
            quote_lamports: amt.toString(),
            max_slippage_bps: MAX_SLIPPAGE_BPS,
          });
          pendingBuy.add(mint);
        }
      }

      // --- exits on a fresh price for this coin ---
      if (c.stage > 0 && !pendingSell.has(mint) && held.has(mint)) {
        const h = held.get(mint)!;
        if (h.tokens > 0n) {
          if (p > c.peakSinceEntry) c.peakSinceEntry = p;
          const takeProfit = p >= c.avgEntry * (1 + TAKE_PROFIT);
          const trailed = c.peakSinceEntry > 0 && p <= c.peakSinceEntry * (1 - TRAIL);
          const stopped = p <= c.avgEntry * (1 - HARD_STOP);
          if ((takeProfit || trailed || stopped) && orders.length < maxOrdersPerBatch) {
            orders.push({
              side: "sell",
              client_id: `s${++orderCounter}`,
              mint,
              token_amount: h.tokens.toString(),
              max_slippage_bps: MAX_SLIPPAGE_BPS,
            });
            pendingSell.add(mint);
          }
        }
      }
    }

    // --- sweep every batch: time-stop for ALL open positions. A quiet
    // coin's curve price does not move without trades, so the time-stop
    // still fills near the last price and frees the slot.
    for (const [mint, c] of coins) {
      if (c.stage === 0 || pendingSell.has(mint) || !held.has(mint)) continue;
      if (slot - c.buySlot < MAX_HOLD_SLOTS) continue;
      const h = held.get(mint)!;
      if (h.tokens <= 0n) continue;
      if (orders.length >= maxOrdersPerBatch) break;
      orders.push({
        side: "sell",
        client_id: `s${++orderCounter}`,
        mint,
        token_amount: h.tokens.toString(),
        max_slippage_bps: MAX_SLIPPAGE_BPS,
      });
      pendingSell.add(mint);
    }

    // Keep replies small and deterministic: at most maxOrdersPerBatch.
    const reply = { type: "reply", seq, orders: orders.slice(0, maxOrdersPerBatch) };
    process.stdout.write(JSON.stringify(reply) + "\n");
  });
}

main();
