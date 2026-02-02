#!/usr/bin/env node
/**
 * signal.js — 综合交易信号评分系统
 * 
 * 多维度指标综合 → 单一分数 (-100 到 +100)
 * 正 = 看多信号，负 = 看空信号，0附近 = 观望
 * 
 * Usage:
 *   node signal.js              — BTC 综合信号
 *   node signal.js eth          — ETH 综合信号
 *   node signal.js btc --detail — 详细各维度评分
 *   node signal.js btc --json   — JSON 输出（给其他工具用）
 */

const https = require('https');

function fetch(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { timeout: 10000 }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(null); } });
    }).on('error', reject).on('timeout', function() { this.destroy(); reject(new Error('timeout')); });
  });
}

// ============ 数据采集 ============

async function collectData(coin = 'BTC') {
  const instId = `${coin}-USDT-SWAP`;
  const spotId = `${coin}-USDT`;
  const uly = `${coin}-USDT`;
  const data = {};

  // 并发拉取所有数据
  const tasks = [
    // 1. 资金费率
    fetch(`https://www.okx.com/api/v5/public/funding-rate?instId=${instId}`)
      .then(r => { data.fundingRate = parseFloat(r?.data?.[0]?.fundingRate || 0); })
      .catch(() => {}),

    // 2. 资金费率历史（6期=48h）
    fetch(`https://www.okx.com/api/v5/public/funding-rate-history?instId=${instId}&limit=6`)
      .then(r => { data.fundingHistory = (r?.data || []).map(d => parseFloat(d.fundingRate)); })
      .catch(() => {}),

    // 3. 持仓量
    fetch(`https://www.okx.com/api/v5/public/open-interest?instType=SWAP&instId=${instId}`)
      .then(r => { data.oi = parseFloat(r?.data?.[0]?.oiUsd || 0); })
      .catch(() => {}),

    // 4. 多空比
    fetch(`https://www.okx.com/api/v5/rubik/stat/contracts/long-short-account-ratio?ccy=${coin}&period=1H`)
      .then(r => {
        if (r?.data?.length >= 2) {
          data.longShortCurrent = parseFloat(r.data[0][1]);
          data.longShortPrev = parseFloat(r.data[Math.min(7, r.data.length - 1)][1]);
        }
      })
      .catch(() => {}),

    // 5. 杠杆借贷比
    fetch(`https://www.okx.com/api/v5/rubik/stat/margin/loan-ratio?ccy=${coin}&period=1H`)
      .then(r => {
        if (r?.data?.length >= 2) {
          data.marginLending = parseFloat(r.data[0][1]);
          data.marginLendingPrev = parseFloat(r.data[Math.min(7, r.data.length - 1)][1]);
        }
      })
      .catch(() => {}),

    // 6. K线（4h，24根=4天，计算技术指标）
    fetch(`https://www.okx.com/api/v5/market/candles?instId=${instId}&bar=4H&limit=50`)
      .then(r => {
        if (r?.data?.length) {
          data.candles = r.data.map(c => ({
            ts: parseInt(c[0]),
            o: parseFloat(c[1]),
            h: parseFloat(c[2]),
            l: parseFloat(c[3]),
            c: parseFloat(c[4]),
            vol: parseFloat(c[5]),
          })).reverse(); // 时间正序
        }
      })
      .catch(() => {}),

    // 7. 恐惧贪婪
    fetch('https://api.alternative.me/fng/?limit=1')
      .then(r => { data.fearGreed = parseInt(r?.data?.[0]?.value || 50); })
      .catch(() => {}),

    // 8. 爆仓
    fetch(`https://www.okx.com/api/v5/public/liquidation-orders?instType=SWAP&uly=${uly}&state=filled&limit=1`)
      .then(r => {
        if (r?.data?.[0]?.details) {
          let longLiq = 0, shortLiq = 0;
          for (const d of r.data[0].details) {
            const sz = parseFloat(d.sz || 0);
            if (d.posSide === 'long' || d.side === 'sell') longLiq += sz;
            else shortLiq += sz;
          }
          data.liqLong = longLiq;
          data.liqShort = shortLiq;
        }
      })
      .catch(() => {}),
  ];

  await Promise.all(tasks);
  return data;
}

// ============ 技术指标计算 ============

function calcRSI(candles, period = 14) {
  if (!candles || candles.length < period + 1) return 50;
  const changes = [];
  for (let i = 1; i < candles.length; i++) {
    changes.push(candles[i].c - candles[i - 1].c);
  }
  
  let avgGain = 0, avgLoss = 0;
  for (let i = 0; i < period; i++) {
    if (changes[i] > 0) avgGain += changes[i];
    else avgLoss -= changes[i];
  }
  avgGain /= period;
  avgLoss /= period;
  
  for (let i = period; i < changes.length; i++) {
    if (changes[i] > 0) {
      avgGain = (avgGain * (period - 1) + changes[i]) / period;
      avgLoss = (avgLoss * (period - 1)) / period;
    } else {
      avgGain = (avgGain * (period - 1)) / period;
      avgLoss = (avgLoss * (period - 1) - changes[i]) / period;
    }
  }
  
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

function calcEMA(values, period) {
  const k = 2 / (period + 1);
  let ema = values[0];
  for (let i = 1; i < values.length; i++) {
    ema = values[i] * k + ema * (1 - k);
  }
  return ema;
}

function calcMACD(candles) {
  if (!candles || candles.length < 26) return { macd: 0, signal: 0, hist: 0 };
  const closes = candles.map(c => c.c);
  
  // EMA12 and EMA26
  let ema12 = closes[0], ema26 = closes[0];
  const k12 = 2 / 13, k26 = 2 / 27;
  const macdLine = [];
  
  for (let i = 1; i < closes.length; i++) {
    ema12 = closes[i] * k12 + ema12 * (1 - k12);
    ema26 = closes[i] * k26 + ema26 * (1 - k26);
    if (i >= 25) macdLine.push(ema12 - ema26);
  }
  
  if (macdLine.length < 9) return { macd: macdLine[macdLine.length - 1] || 0, signal: 0, hist: 0 };
  
  // Signal = EMA9 of MACD
  let signal = macdLine[0];
  const k9 = 2 / 10;
  for (let i = 1; i < macdLine.length; i++) {
    signal = macdLine[i] * k9 + signal * (1 - k9);
  }
  
  const macd = macdLine[macdLine.length - 1];
  return { macd, signal, hist: macd - signal };
}

function calcBollinger(candles, period = 20) {
  if (!candles || candles.length < period) return null;
  const closes = candles.slice(-period).map(c => c.c);
  const sma = closes.reduce((a, b) => a + b, 0) / period;
  const variance = closes.reduce((sum, c) => sum + Math.pow(c - sma, 2), 0) / period;
  const std = Math.sqrt(variance);
  const currentPrice = candles[candles.length - 1].c;
  
  return {
    upper: sma + 2 * std,
    middle: sma,
    lower: sma - 2 * std,
    percentB: (currentPrice - (sma - 2 * std)) / (4 * std), // 0-1, below 0 = below lower band
  };
}

// ============ 评分引擎 ============

function scoreSignals(data) {
  const scores = {};
  const details = {};

  // --- 1. 资金费率评分 (权重 15%) ---
  if (data.fundingRate !== undefined) {
    const fr = data.fundingRate;
    let score = 0;
    if (fr < -0.001) score = 30;        // 深度负费率 → 超卖，看多
    else if (fr < -0.0003) score = 15;   // 轻度负费率 → 偏多
    else if (fr < 0.0005) score = 0;     // 正常区间 → 中性
    else if (fr < 0.001) score = -15;    // 偏高 → 偏空
    else score = -30;                    // 极端正费率 → 过热，看空
    scores.funding = score;
    details.funding = `费率 ${(fr * 100).toFixed(4)}% → ${score > 0 ? '偏多' : score < 0 ? '偏空' : '中性'}`;
  }

  // --- 2. 费率趋势 (权重 10%) ---
  if (data.fundingHistory?.length >= 3) {
    const recent = data.fundingHistory.slice(0, 3);
    const older = data.fundingHistory.slice(3);
    const recentAvg = recent.reduce((a, b) => a + b, 0) / recent.length;
    const olderAvg = older.length ? older.reduce((a, b) => a + b, 0) / older.length : recentAvg;
    
    let score = 0;
    if (recentAvg < olderAvg && recentAvg < 0) score = 20;     // 费率走低且为负
    else if (recentAvg < olderAvg) score = 10;                   // 费率在下降
    else if (recentAvg > olderAvg && recentAvg > 0.0008) score = -20; // 费率走高且过高
    else if (recentAvg > olderAvg) score = -10;                  // 费率在上升
    scores.fundingTrend = score;
    details.fundingTrend = `费率趋势 ${recentAvg > olderAvg ? '↑' : '↓'} → ${score > 0 ? '偏多' : score < 0 ? '偏空' : '中性'}`;
  }

  // --- 3. 多空比（反向指标）(权重 15%) ---
  if (data.longShortCurrent) {
    const ls = data.longShortCurrent;
    let score = 0;
    if (ls > 3.5) score = -25;          // 散户极端看多 → 反向看空
    else if (ls > 2.8) score = -10;     // 散户偏多 → 轻度看空
    else if (ls < 1.2) score = 25;      // 散户极端看空 → 反向看多
    else if (ls < 1.8) score = 10;      // 散户偏空 → 轻度看多
    scores.longShort = score;
    details.longShort = `多空比 ${ls.toFixed(2)}:1 → ${score > 0 ? '偏多(反向)' : score < 0 ? '偏空(反向)' : '中性'}`;
    
    // 多空比变化趋势
    if (data.longShortPrev) {
      const change = data.longShortCurrent - data.longShortPrev;
      if (Math.abs(change) > 0.3) {
        const trendScore = change > 0 ? -5 : 5; // 散户涌入做多 = 反向偏空
        scores.longShort += trendScore;
        details.longShort += ` (变化 ${change > 0 ? '+' : ''}${change.toFixed(2)})`;
      }
    }
  }

  // --- 4. 恐惧贪婪（反向指标）(权重 15%) ---
  if (data.fearGreed !== undefined) {
    const fg = data.fearGreed;
    let score = 0;
    if (fg <= 10) score = 30;           // 极度恐惧 → 强烈看多
    else if (fg <= 25) score = 15;      // 恐惧 → 偏多
    else if (fg <= 45) score = 5;       // 偏恐惧 → 轻度看多
    else if (fg <= 55) score = 0;       // 中性
    else if (fg <= 75) score = -5;      // 偏贪婪 → 轻度看空
    else if (fg <= 90) score = -15;     // 贪婪 → 偏空
    else score = -30;                   // 极度贪婪 → 强烈看空
    scores.fearGreed = score;
    details.fearGreed = `恐惧贪婪 ${fg} → ${score > 0 ? '偏多(反向)' : score < 0 ? '偏空(反向)' : '中性'}`;
  }

  // --- 5. RSI (权重 15%) ---
  if (data.candles?.length >= 15) {
    const rsi = calcRSI(data.candles);
    let score = 0;
    if (rsi < 20) score = 30;           // 极度超卖
    else if (rsi < 30) score = 15;      // 超卖
    else if (rsi < 45) score = 5;
    else if (rsi > 80) score = -30;     // 极度超买
    else if (rsi > 70) score = -15;     // 超买
    else if (rsi > 55) score = -5;
    scores.rsi = score;
    details.rsi = `RSI(14) ${rsi.toFixed(1)} → ${score > 0 ? '超卖偏多' : score < 0 ? '超买偏空' : '中性'}`;
  }

  // --- 6. MACD (权重 10%) ---
  if (data.candles?.length >= 30) {
    const macd = calcMACD(data.candles);
    let score = 0;
    if (macd.hist > 0 && macd.macd > 0) score = 15;       // 多头趋势
    else if (macd.hist > 0) score = 10;                     // 金叉
    else if (macd.hist < 0 && macd.macd < 0) score = -15;  // 空头趋势
    else if (macd.hist < 0) score = -10;                    // 死叉
    scores.macd = score;
    details.macd = `MACD hist ${macd.hist > 0 ? '+' : ''}${macd.hist.toFixed(2)} → ${score > 0 ? '偏多' : score < 0 ? '偏空' : '中性'}`;
  }

  // --- 7. 布林带位置 (权重 10%) ---
  if (data.candles?.length >= 20) {
    const bb = calcBollinger(data.candles);
    if (bb) {
      let score = 0;
      if (bb.percentB < 0) score = 20;         // 跌破下轨 → 超卖
      else if (bb.percentB < 0.2) score = 10;  // 靠近下轨
      else if (bb.percentB > 1) score = -20;   // 突破上轨 → 超买
      else if (bb.percentB > 0.8) score = -10; // 靠近上轨
      scores.bollinger = score;
      details.bollinger = `布林 %B ${(bb.percentB * 100).toFixed(1)}% → ${score > 0 ? '下轨附近偏多' : score < 0 ? '上轨附近偏空' : '中轨附近'}`;
    }
  }

  // --- 8. 爆仓方向 (权重 10%) ---
  if (data.liqLong !== undefined && data.liqShort !== undefined) {
    const total = data.liqLong + data.liqShort;
    if (total > 0) {
      const longPct = data.liqLong / total;
      let score = 0;
      if (longPct > 0.8) score = 15;       // 多头大量爆仓 → 可能见底
      else if (longPct > 0.6) score = 5;
      else if (longPct < 0.2) score = -15;  // 空头大量爆仓 → 可能见顶
      else if (longPct < 0.4) score = -5;
      scores.liquidation = score;
      details.liquidation = `爆仓 多:${data.liqLong.toFixed(1)} 空:${data.liqShort.toFixed(1)} → ${score > 0 ? '多头出清偏多' : score < 0 ? '空头出清偏空' : '均衡'}`;
    }
  }

  return { scores, details };
}

// ============ 综合评分 ============

function aggregate(scores) {
  const weights = {
    funding: 15,
    fundingTrend: 10,
    longShort: 15,
    fearGreed: 15,
    rsi: 15,
    macd: 10,
    bollinger: 10,
    liquidation: 10,
  };

  let totalScore = 0;
  let totalWeight = 0;
  
  for (const [key, weight] of Object.entries(weights)) {
    if (scores[key] !== undefined) {
      totalScore += scores[key] * weight;
      totalWeight += weight;
    }
  }

  if (totalWeight === 0) return 0;
  return Math.round(totalScore / totalWeight * 100) / 100;
}

function getSignalLabel(score) {
  if (score >= 15) return '🟢 强烈看多';
  if (score >= 8) return '🟢 偏多';
  if (score >= 3) return '🔵 轻度看多';
  if (score > -3) return '⚪ 观望';
  if (score > -8) return '🔵 轻度看空';
  if (score > -15) return '🔴 偏空';
  return '🔴 强烈看空';
}

function getAction(score) {
  if (score >= 15) return '建议：可以分批建仓做多';
  if (score >= 8) return '建议：可以小仓试多，等回调加仓';
  if (score >= 3) return '建议：观望为主，有回调机会可小试';
  if (score > -3) return '建议：观望，等待明确信号';
  if (score > -8) return '建议：观望为主，谨慎做空';
  if (score > -15) return '建议：减仓/轻仓做空';
  return '建议：空仓观望或做空对冲';
}

// ============ Main ============

async function main() {
  const args = process.argv.slice(2);
  const coin = (args.find(a => !a.startsWith('-')) || 'BTC').toUpperCase();
  const detail = args.includes('--detail') || args.includes('-d');
  const json = args.includes('--json') || args.includes('-j');

  console.log(`\n⚡ ${coin} 综合交易信号`);
  console.log('══════════════════════════════════════');
  console.log('  数据采集中...');

  const data = await collectData(coin);
  const { scores, details } = scoreSignals(data);
  const total = aggregate(scores);
  const label = getSignalLabel(total);

  if (json) {
    console.log(JSON.stringify({ coin, score: total, label, scores, details, ts: Date.now() }, null, 2));
    return;
  }

  console.log('\r                        ');

  // Score bar visualization
  const barWidth = 40;
  const normalized = Math.max(-30, Math.min(30, total));
  const center = barWidth / 2;
  const pos = Math.round(center + (normalized / 30) * center);
  let bar = '';
  for (let i = 0; i < barWidth; i++) {
    if (i === center) bar += '│';
    else if (i === pos) bar += '◆';
    else if ((i > center && i <= pos) || (i < center && i >= pos)) bar += '═';
    else bar += '─';
  }

  console.log(`  评分: ${total.toFixed(1)}  ${label}`);
  console.log(`  空 [${bar}] 多`);
  console.log(`  ${getAction(total)}`);
  console.log();

  if (detail) {
    console.log('  📋 各维度评分');
    console.log('  ─────────────────────────────────');
    for (const [key, desc] of Object.entries(details)) {
      const s = scores[key];
      const icon = s > 0 ? '🟢' : s < 0 ? '🔴' : '⚪';
      console.log(`  ${icon} ${desc}`);
    }
    console.log();
  }

  console.log(`  ⏰ ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`);
  console.log();
}

main().catch(e => console.error('Error:', e.message));
