#!/usr/bin/env node
/**
 * backtest.js — 信号回测验证工具
 * 
 * 用历史K线数据回测技术指标信号的准确率
 * （链上指标如多空比/费率无历史免费API，仅回测技术面）
 * 
 * Usage:
 *   node backtest.js                    — BTC 4H 默认回测
 *   node backtest.js eth 1H             — ETH 1小时级别
 *   node backtest.js btc 4H --trades    — 显示每笔交易
 *   node backtest.js btc 1D             — 日线级别
 */

const https = require('https');

function fetch(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { timeout: 15000 }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(null); } });
    }).on('error', reject).on('timeout', function() { this.destroy(); reject(new Error('timeout')); });
  });
}

// ============ 拉取历史数据 ============

async function fetchCandles(instId, bar = '4H', limit = 300) {
  // OKX 最多一次返回 300 根，可分页
  const allCandles = [];
  let after = '';
  const batchSize = 300;
  const needed = Math.min(limit, 600); // 最多拉两页
  
  while (allCandles.length < needed) {
    const url = `https://www.okx.com/api/v5/market/candles?instId=${instId}&bar=${bar}&limit=${batchSize}${after ? '&after=' + after : ''}`;
    const r = await fetch(url);
    if (!r?.data?.length) break;
    
    const candles = r.data.map(c => ({
      ts: parseInt(c[0]),
      o: parseFloat(c[1]),
      h: parseFloat(c[2]),
      l: parseFloat(c[3]),
      c: parseFloat(c[4]),
      vol: parseFloat(c[5]),
    }));
    
    allCandles.push(...candles);
    after = candles[candles.length - 1].ts;
    
    if (r.data.length < batchSize) break;
    await new Promise(r => setTimeout(r, 200)); // rate limit
  }
  
  return allCandles.reverse(); // 时间正序
}

// ============ 技术指标 ============

function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const change = closes[i] - closes[i - 1];
    if (change > 0) avgGain += change;
    else avgLoss -= change;
  }
  avgGain /= period;
  avgLoss /= period;
  
  const rsiSeries = [];
  for (let i = 0; i <= period; i++) rsiSeries.push(null);
  
  if (avgLoss === 0) rsiSeries.push(100);
  else rsiSeries.push(100 - 100 / (1 + avgGain / avgLoss));
  
  for (let i = period + 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    if (change > 0) {
      avgGain = (avgGain * (period - 1) + change) / period;
      avgLoss = (avgLoss * (period - 1)) / period;
    } else {
      avgGain = (avgGain * (period - 1)) / period;
      avgLoss = (avgLoss * (period - 1) - change) / period;
    }
    if (avgLoss === 0) rsiSeries.push(100);
    else rsiSeries.push(100 - 100 / (1 + avgGain / avgLoss));
  }
  return rsiSeries;
}

function calcEMASeries(values, period) {
  const k = 2 / (period + 1);
  const ema = [values[0]];
  for (let i = 1; i < values.length; i++) {
    ema.push(values[i] * k + ema[i - 1] * (1 - k));
  }
  return ema;
}

function calcMACDSeries(closes) {
  const ema12 = calcEMASeries(closes, 12);
  const ema26 = calcEMASeries(closes, 26);
  const macdLine = ema12.map((v, i) => v - ema26[i]);
  const signal = calcEMASeries(macdLine, 9);
  return macdLine.map((v, i) => ({
    macd: v,
    signal: signal[i],
    hist: v - signal[i],
  }));
}

function calcBollingerSeries(closes, period = 20) {
  const result = [];
  for (let i = 0; i < closes.length; i++) {
    if (i < period - 1) { result.push(null); continue; }
    const slice = closes.slice(i - period + 1, i + 1);
    const sma = slice.reduce((a, b) => a + b, 0) / period;
    const std = Math.sqrt(slice.reduce((s, c) => s + (c - sma) ** 2, 0) / period);
    result.push({
      upper: sma + 2 * std,
      middle: sma,
      lower: sma - 2 * std,
      percentB: std > 0 ? (closes[i] - (sma - 2 * std)) / (4 * std) : 0.5,
    });
  }
  return result;
}

// ============ 信号生成 ============

function generateSignals(candles) {
  const closes = candles.map(c => c.c);
  const rsiSeries = calcRSI(closes);
  const macdSeries = calcMACDSeries(closes);
  const bbSeries = calcBollingerSeries(closes);
  
  const signals = [];
  
  for (let i = 30; i < candles.length; i++) { // 需要至少 30 根历史
    let score = 0;
    const reasons = [];
    
    // RSI
    const rsi = rsiSeries[i];
    if (rsi !== null) {
      if (rsi < 20) { score += 30; reasons.push(`RSI ${rsi.toFixed(0)} 极度超卖`); }
      else if (rsi < 30) { score += 15; reasons.push(`RSI ${rsi.toFixed(0)} 超卖`); }
      else if (rsi < 45) { score += 5; }
      else if (rsi > 80) { score -= 30; reasons.push(`RSI ${rsi.toFixed(0)} 极度超买`); }
      else if (rsi > 70) { score -= 15; reasons.push(`RSI ${rsi.toFixed(0)} 超买`); }
      else if (rsi > 55) { score -= 5; }
    }
    
    // MACD
    const macd = macdSeries[i];
    if (macd.hist > 0 && macd.macd > 0) score += 15;
    else if (macd.hist > 0) score += 10;
    else if (macd.hist < 0 && macd.macd < 0) score -= 15;
    else if (macd.hist < 0) score -= 10;
    
    // MACD 金叉/死叉
    if (i > 0) {
      const prevMacd = macdSeries[i - 1];
      if (prevMacd.hist <= 0 && macd.hist > 0) { score += 10; reasons.push('MACD 金叉'); }
      if (prevMacd.hist >= 0 && macd.hist < 0) { score -= 10; reasons.push('MACD 死叉'); }
    }
    
    // Bollinger
    const bb = bbSeries[i];
    if (bb) {
      if (bb.percentB < 0) { score += 20; reasons.push('跌破布林下轨'); }
      else if (bb.percentB < 0.15) { score += 10; reasons.push('靠近布林下轨'); }
      else if (bb.percentB > 1) { score -= 20; reasons.push('突破布林上轨'); }
      else if (bb.percentB > 0.85) { score -= 10; reasons.push('靠近布林上轨'); }
    }
    
    // 均线趋势 (EMA20 vs EMA50)
    if (i >= 50) {
      const ema20 = closes.slice(i - 19, i + 1).reduce((a, b) => a + b) / 20;
      const ema50 = closes.slice(i - 49, i + 1).reduce((a, b) => a + b) / 50;
      if (closes[i] > ema20 && ema20 > ema50) score += 10;
      else if (closes[i] < ema20 && ema20 < ema50) score -= 10;
    }
    
    // 归一化到 -100 ~ +100
    const normalized = Math.max(-100, Math.min(100, score * 2));
    
    signals.push({
      idx: i,
      ts: candles[i].ts,
      price: candles[i].c,
      score: normalized,
      rsi: rsi?.toFixed(1),
      macdHist: macd.hist.toFixed(2),
      bbPctB: bb?.percentB?.toFixed(3),
      reasons,
    });
  }
  
  return signals;
}

// ============ 回测策略 ============

function runBacktest(signals, candles) {
  const trades = [];
  let position = null; // { side, entry, entryIdx, score }
  let totalPnl = 0;
  let wins = 0, losses = 0;
  let maxDrawdown = 0;
  let peak = 0;
  let equity = 0;
  
  const ENTRY_THRESHOLD = 20;     // score > 20 做多，< -20 做空
  const EXIT_THRESHOLD = 5;       // 信号反转到反方向 5 分以上平仓
  const STOP_LOSS_PCT = 0.03;     // 3% 止损
  const TAKE_PROFIT_PCT = 0.06;   // 6% 止盈（2:1 盈亏比）
  const LOOKFORWARD = 1;          // 下一根K线开仓（避免用未来数据）

  for (let i = 0; i < signals.length - LOOKFORWARD; i++) {
    const sig = signals[i];
    const nextCandle = candles[sig.idx + LOOKFORWARD];
    if (!nextCandle) continue;
    const execPrice = nextCandle.o; // 下一根开盘价执行
    
    // 检查止损/止盈
    if (position) {
      const pnlPct = position.side === 'long' 
        ? (execPrice - position.entry) / position.entry
        : (position.entry - execPrice) / position.entry;
      
      if (pnlPct <= -STOP_LOSS_PCT || pnlPct >= TAKE_PROFIT_PCT) {
        const pnl = pnlPct * 100;
        totalPnl += pnl;
        equity += pnl;
        if (equity > peak) peak = equity;
        const dd = peak - equity;
        if (dd > maxDrawdown) maxDrawdown = dd;
        
        if (pnl > 0) wins++; else losses++;
        trades.push({
          side: position.side,
          entry: position.entry,
          exit: execPrice,
          pnl: pnl.toFixed(2) + '%',
          reason: pnlPct >= TAKE_PROFIT_PCT ? '止盈' : '止损',
          entryTime: new Date(candles[position.entryIdx].ts).toISOString().slice(0, 16),
          exitTime: new Date(nextCandle.ts).toISOString().slice(0, 16),
          holdBars: sig.idx - position.entryIdx,
        });
        position = null;
        continue;
      }
      
      // 反向信号平仓
      if ((position.side === 'long' && sig.score < -EXIT_THRESHOLD) ||
          (position.side === 'short' && sig.score > EXIT_THRESHOLD)) {
        const pnl = pnlPct * 100;
        totalPnl += pnl;
        equity += pnl;
        if (equity > peak) peak = equity;
        const dd = peak - equity;
        if (dd > maxDrawdown) maxDrawdown = dd;
        
        if (pnl > 0) wins++; else losses++;
        trades.push({
          side: position.side,
          entry: position.entry,
          exit: execPrice,
          pnl: pnl.toFixed(2) + '%',
          reason: '信号反转',
          entryTime: new Date(candles[position.entryIdx].ts).toISOString().slice(0, 16),
          exitTime: new Date(nextCandle.ts).toISOString().slice(0, 16),
          holdBars: sig.idx - position.entryIdx,
        });
        position = null;
      }
    }
    
    // 开仓信号
    if (!position) {
      if (sig.score >= ENTRY_THRESHOLD) {
        position = { side: 'long', entry: execPrice, entryIdx: sig.idx + LOOKFORWARD, score: sig.score };
      } else if (sig.score <= -ENTRY_THRESHOLD) {
        position = { side: 'short', entry: execPrice, entryIdx: sig.idx + LOOKFORWARD, score: sig.score };
      }
    }
  }
  
  // 强制平仓未完成交易
  if (position) {
    const lastPrice = candles[candles.length - 1].c;
    const pnlPct = position.side === 'long'
      ? (lastPrice - position.entry) / position.entry
      : (position.entry - lastPrice) / position.entry;
    const pnl = pnlPct * 100;
    totalPnl += pnl;
    if (pnl > 0) wins++; else losses++;
    trades.push({
      side: position.side,
      entry: position.entry,
      exit: lastPrice,
      pnl: pnl.toFixed(2) + '%',
      reason: '回测结束',
      entryTime: new Date(candles[position.entryIdx].ts).toISOString().slice(0, 16),
      exitTime: 'NOW',
      holdBars: candles.length - 1 - position.entryIdx,
    });
  }
  
  const total = wins + losses;
  const winRate = total > 0 ? (wins / total * 100).toFixed(1) : 0;
  const avgPnl = total > 0 ? (totalPnl / total).toFixed(2) : 0;
  const avgWin = wins > 0 ? (trades.filter(t => parseFloat(t.pnl) > 0).reduce((s, t) => s + parseFloat(t.pnl), 0) / wins).toFixed(2) : 0;
  const avgLoss = losses > 0 ? (trades.filter(t => parseFloat(t.pnl) <= 0).reduce((s, t) => s + parseFloat(t.pnl), 0) / losses).toFixed(2) : 0;
  
  return {
    trades,
    stats: {
      totalTrades: total,
      wins,
      losses,
      winRate: winRate + '%',
      totalPnl: totalPnl.toFixed(2) + '%',
      avgPnl: avgPnl + '%',
      avgWin: avgWin + '%',
      avgLoss: avgLoss + '%',
      profitFactor: losses > 0 && avgLoss != 0 ? Math.abs(wins * avgWin / (losses * avgLoss)).toFixed(2) : 'N/A',
      maxDrawdown: maxDrawdown.toFixed(2) + '%',
    },
  };
}

// ============ Main ============

async function main() {
  const args = process.argv.slice(2).filter(a => !a.startsWith('-'));
  const flags = process.argv.slice(2).filter(a => a.startsWith('-'));
  
  const coin = (args[0] || 'BTC').toUpperCase();
  const bar = args[1] || '4H';
  const showTrades = flags.includes('--trades') || flags.includes('-t');
  
  const instId = `${coin}-USDT-SWAP`;
  
  console.log(`\n📊 ${coin} 信号回测 (${bar} K线)`);
  console.log('══════════════════════════════════════');
  console.log('  拉取历史数据...');
  
  const candles = await fetchCandles(instId, bar, 500);
  console.log(`  获取 ${candles.length} 根K线`);
  
  if (candles.length < 50) {
    console.log('  ⚠️ 数据不足，至少需要 50 根K线');
    return;
  }
  
  const startDate = new Date(candles[0].ts).toISOString().slice(0, 10);
  const endDate = new Date(candles[candles.length - 1].ts).toISOString().slice(0, 10);
  const startPrice = candles[30].c; // 信号从第30根开始
  const endPrice = candles[candles.length - 1].c;
  const buyHold = ((endPrice - startPrice) / startPrice * 100).toFixed(2);
  
  console.log(`  区间: ${startDate} → ${endDate}`);
  console.log(`  价格: $${startPrice.toLocaleString()} → $${endPrice.toLocaleString()} (Buy&Hold: ${buyHold}%)`);
  console.log();
  
  // 生成信号
  const signals = generateSignals(candles);
  
  // 信号分布
  let bullish = 0, bearish = 0, neutral = 0;
  for (const s of signals) {
    if (s.score >= 20) bullish++;
    else if (s.score <= -20) bearish++;
    else neutral++;
  }
  console.log(`  信号分布: 🟢多 ${bullish} | ⚪观望 ${neutral} | 🔴空 ${bearish}`);
  
  // 回测
  const result = runBacktest(signals, candles);
  const s = result.stats;
  
  console.log();
  console.log('  📈 回测结果');
  console.log('  ─────────────────────────────────');
  console.log(`  总交易: ${s.totalTrades}笔 (胜 ${s.wins} / 负 ${s.losses})`);
  console.log(`  胜率: ${s.winRate}`);
  console.log(`  累计收益: ${s.totalPnl} (vs Buy&Hold ${buyHold}%)`);
  console.log(`  平均收益: ${s.avgPnl}/笔`);
  console.log(`  平均盈利: ${s.avgWin} | 平均亏损: ${s.avgLoss}`);
  console.log(`  盈亏比: ${s.profitFactor}`);
  console.log(`  最大回撤: ${s.maxDrawdown}`);
  
  // 策略参数
  console.log();
  console.log('  ⚙️ 策略参数');
  console.log('  ─────────────────────────────────');
  console.log('  开仓阈值: ±20 分');
  console.log('  止损: -3% | 止盈: +6% (盈亏比 2:1)');
  console.log('  执行: 下一根K线开盘价（无未来数据泄露）');
  console.log('  指标: RSI(14) + MACD(12,26,9) + Bollinger(20,2) + MA趋势');
  
  // 交易明细
  if (showTrades && result.trades.length > 0) {
    console.log();
    console.log('  📋 交易明细');
    console.log('  ─────────────────────────────────');
    for (const t of result.trades) {
      const icon = parseFloat(t.pnl) > 0 ? '✅' : '❌';
      console.log(`  ${icon} ${t.side.toUpperCase().padEnd(5)} $${t.entry.toFixed(2)} → $${t.exit.toFixed(2)} ${t.pnl.padStart(8)} [${t.reason}] ${t.entryTime} (${t.holdBars}根)`);
    }
  }
  
  // 评级
  console.log();
  const wr = parseFloat(s.winRate);
  const tp = parseFloat(s.totalPnl);
  let grade = '';
  if (wr >= 55 && tp > parseFloat(buyHold)) grade = '⭐⭐⭐ 优秀 — 信号有 edge，可考虑实盘验证';
  else if (wr >= 50 && tp > 0) grade = '⭐⭐ 及格 — 有盈利但需优化参数';
  else if (wr >= 45) grade = '⭐ 一般 — 接近随机，需要改进策略';
  else grade = '❌ 不合格 — 信号无效，需要重新设计';
  console.log(`  评级: ${grade}`);
  console.log();
}

main().catch(e => console.error('Error:', e.message));
