#!/usr/bin/env node
/**
 * market-data.js — 综合金融市场数据仪表盘
 * 
 * 免费数据源整合：
 * - Yahoo Finance: VIX, DXY, S&P500, 纳斯达克, 黄金, 原油, 美债收益率
 * - Alternative.me: 加密恐惧贪婪指数
 * - DefiLlama: 稳定币总市值 & Top 稳定币
 * - CoinGecko: BTC/ETH/SOL 价格 (已有 crypto.js，这里做精简版)
 * - Binance: BTC 资金费率 & 未平仓合约 (公共API)
 * 
 * Usage:
 *   node market-data.js              — 全景仪表盘
 *   node market-data.js macro        — 仅宏观指标
 *   node market-data.js crypto       — 仅加密指标
 *   node market-data.js sentiment    — 仅情绪指标
 *   node market-data.js stablecoins  — 稳定币数据
 *   node market-data.js funding      — 资金费率 & OI
 *   node market-data.js derivatives  — 衍生品深度分析（多空比/爆仓/杠杆/费率历史）
 */

const https = require('https');
const http = require('http');

// ============ HTTP Helper ============
function fetch(url, options = {}) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { headers: options.headers || {}, timeout: 10000 }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve(data); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

// ============ Yahoo Finance (VIX, DXY, SPX, etc.) ============
async function getYahooQuotes() {
  const symbols = {
    'VIX': '^VIX',
    'S&P500': '^GSPC',
    'NASDAQ': '^IXIC',
    'DJI': '^DJI',
    'DXY': 'DX-Y.NYB',
    'Gold': 'GC=F',
    'Silver': 'SI=F',
    'WTI Oil': 'CL=F',
    'US10Y': '^TNX',
    'US2Y': '^IRX',  // 13-week tbill as proxy
  };

  const results = {};
  // Use yahoo-finance2 npm
  try {
    const { default: YahooFinance } = require('yahoo-finance2');
    const yf = new YahooFinance({ suppressNotices: ['yahooSurvey'] });
    
    for (const [name, ticker] of Object.entries(symbols)) {
      try {
        const q = await yf.quote(ticker);
        if (q) {
          results[name] = {
            price: q.regularMarketPrice,
            change: q.regularMarketChangePercent?.toFixed(2) + '%',
            prevClose: q.regularMarketPreviousClose,
          };
        }
      } catch (e2) { /* skip individual failures */ }
    }
  } catch (e) {
    console.error('  Yahoo Finance error:', e.message);
  }
  return results;
}

// ============ Fear & Greed Index ============
async function getFearGreed() {
  try {
    const data = await fetch('https://api.alternative.me/fng/?limit=7');
    if (data?.data) {
      return {
        current: { value: data.data[0].value, label: data.data[0].value_classification },
        week: data.data.map(d => ({ value: d.value, label: d.value_classification })),
      };
    }
  } catch (e) {
    console.error('  Fear & Greed error:', e.message);
  }
  return null;
}

// ============ Stablecoins (DefiLlama) ============
async function getStablecoins() {
  try {
    const data = await fetch('https://stablecoins.llama.fi/stablecoins?includePrices=true');
    if (data?.peggedAssets) {
      const top = data.peggedAssets
        .filter(s => s.circulating?.peggedUSD > 100000000) // >$100M
        .sort((a, b) => (b.circulating?.peggedUSD || 0) - (a.circulating?.peggedUSD || 0))
        .slice(0, 8);
      
      const totalMcap = data.peggedAssets.reduce((sum, s) => sum + (s.circulating?.peggedUSD || 0), 0);
      
      return {
        totalMcap,
        top: top.map(s => ({
          name: s.name,
          symbol: s.symbol,
          mcap: s.circulating?.peggedUSD,
        })),
      };
    }
  } catch (e) {
    console.error('  Stablecoins error:', e.message);
  }
  return null;
}

// ============ Funding Rate & OI (OKX Public API - no geo-block) ============
async function getFundingData() {
  const results = {};
  const coins = [
    { coin: 'BTC', instId: 'BTC-USDT-SWAP' },
    { coin: 'ETH', instId: 'ETH-USDT-SWAP' },
    { coin: 'SOL', instId: 'SOL-USDT-SWAP' },
  ];
  
  for (const { coin, instId } of coins) {
    try {
      // Funding rate
      const fr = await fetch(`https://www.okx.com/api/v5/public/funding-rate?instId=${instId}`);
      // Open Interest
      const oi = await fetch(`https://www.okx.com/api/v5/public/open-interest?instType=SWAP&instId=${instId}`);
      // Mark price
      const mp = await fetch(`https://www.okx.com/api/v5/public/mark-price?instType=SWAP&instId=${instId}`);
      
      const frData = fr?.data?.[0];
      const oiData = oi?.data?.[0];
      const mpData = mp?.data?.[0];
      
      results[coin] = {
        fundingRate: frData?.fundingRate ? (parseFloat(frData.fundingRate) * 100).toFixed(4) + '%' : 'N/A',
        nextFundingRate: frData?.nextFundingRate ? (parseFloat(frData.nextFundingRate) * 100).toFixed(4) + '%' : undefined,
        markPrice: mpData?.markPx ? parseFloat(mpData.markPx).toFixed(2) : 'N/A',
        openInterest: oiData?.oi ? parseFloat(oiData.oi).toFixed(2) : 'N/A',
        openInterestUSD: (oiData?.oi && mpData?.markPx) ? 
          '$' + (parseFloat(oiData.oi) * parseFloat(mpData.markPx) / 1e9).toFixed(2) + 'B' : undefined,
      };
    } catch (e) {
      results[coin] = { error: e.message };
    }
  }
  return results;
}

// ============ BTC/ETH/SOL Prices (OKX public tickers as primary, CoinGecko as fallback) ============
async function getCryptoPrices() {
  try {
    // Try OKX first (no geo-block)
    const pairs = ['BTC-USDT', 'ETH-USDT', 'SOL-USDT'];
    const results = {};
    for (const pair of pairs) {
      const data = await fetch(`https://www.okx.com/api/v5/market/ticker?instId=${pair}`);
      const t = data?.data?.[0];
      if (t) {
        const coin = pair.split('-')[0];
        const price = parseFloat(t.last);
        const open24h = parseFloat(t.open24h);
        const change = ((price - open24h) / open24h * 100).toFixed(2);
        results[coin] = { price, change24h: change + '%', vol24h: '$' + (parseFloat(t.volCcy24h) / 1e9).toFixed(2) + 'B' };
      }
    }
    if (Object.keys(results).length > 0) return results;
  } catch (e) { /* fallback */ }
  
  // Fallback to CoinGecko
  try {
    const data = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,solana&vs_currencies=usd&include_24hr_change=true&include_market_cap=true');
    return {
      BTC: { price: data.bitcoin?.usd, change24h: data.bitcoin?.usd_24h_change?.toFixed(2) + '%' },
      ETH: { price: data.ethereum?.usd, change24h: data.ethereum?.usd_24h_change?.toFixed(2) + '%' },
      SOL: { price: data.solana?.usd, change24h: data.solana?.usd_24h_change?.toFixed(2) + '%' },
    };
  } catch (e) {
    console.error('  Price error:', e.message);
    return null;
  }
}

// ============ Derivatives Deep Dive (OKX Rubik + Public) ============
async function getDerivativesDeep() {
  const results = {};

  // 1. Long/Short Ratio (BTC, ETH)
  for (const ccy of ['BTC', 'ETH']) {
    try {
      const ls = await fetch(`https://www.okx.com/api/v5/rubik/stat/contracts/long-short-account-ratio?ccy=${ccy}&period=1H`);
      if (ls?.data?.length) {
        const latest = ls.data[0];
        const prev = ls.data[Math.min(7, ls.data.length - 1)]; // ~8h ago
        results[`${ccy}_longShort`] = {
          current: parseFloat(latest[1]).toFixed(2),
          prev8h: prev ? parseFloat(prev[1]).toFixed(2) : null,
        };
      }
    } catch (e) { /* skip */ }
  }

  // 2. Margin Lending Ratio (BTC)
  try {
    const ml = await fetch('https://www.okx.com/api/v5/rubik/stat/margin/loan-ratio?ccy=BTC&period=1H');
    if (ml?.data?.length) {
      results.marginLending = {
        current: parseFloat(ml.data[0][1]).toFixed(2),
        prev8h: ml.data[7] ? parseFloat(ml.data[7][1]).toFixed(2) : null,
      };
    }
  } catch (e) { /* skip */ }

  // 3. Recent Liquidations (BTC-USDT-SWAP)
  try {
    const liq = await fetch('https://www.okx.com/api/v5/public/liquidation-orders?instType=SWAP&uly=BTC-USDT&state=filled&limit=1');
    if (liq?.data?.[0]?.details) {
      const details = liq.data[0].details;
      let longLiq = 0, shortLiq = 0, longCount = 0, shortCount = 0;
      for (const d of details) {
        const sz = parseFloat(d.sz || 0);
        if (d.posSide === 'long' || d.side === 'sell') {
          longLiq += sz; longCount++;
        } else {
          shortLiq += sz; shortCount++;
        }
      }
      results.liquidations = { longLiq, shortLiq, longCount, shortCount, total: details.length };
    }
  } catch (e) { /* skip */ }

  // 4. Funding Rate History (BTC, last 6 periods = 48h)
  try {
    const fh = await fetch('https://www.okx.com/api/v5/public/funding-rate-history?instId=BTC-USDT-SWAP&limit=6');
    if (fh?.data?.length) {
      results.fundingHistory = fh.data.map(d => ({
        rate: (parseFloat(d.fundingRate) * 100).toFixed(4) + '%',
        time: new Date(parseInt(d.fundingTime)).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }),
      }));
    }
  } catch (e) { /* skip */ }

  // 5. Insurance Fund
  try {
    const ins = await fetch('https://www.okx.com/api/v5/public/insurance-fund?instType=SWAP&uly=BTC-USDT&limit=2');
    if (ins?.data?.[0]?.details) {
      const bal = parseFloat(ins.data[0].details[0]?.balance || 0);
      results.insuranceFund = bal;
    }
  } catch (e) { /* skip */ }

  return results;
}

// ============ Display Helpers ============
function fmt(n, prefix = '') {
  if (n === undefined || n === null) return 'N/A';
  if (typeof n === 'string') return prefix + n;
  if (n >= 1e12) return prefix + (n / 1e12).toFixed(2) + 'T';
  if (n >= 1e9) return prefix + (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return prefix + (n / 1e6).toFixed(2) + 'M';
  return prefix + n.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

function arrow(changeStr) {
  if (!changeStr || changeStr === 'N/A') return '';
  const n = parseFloat(changeStr);
  return n >= 0 ? '📈' : '📉';
}

// ============ Main ============
async function main() {
  const cmd = process.argv[2]?.toLowerCase() || 'all';
  const showAll = cmd === 'all';
  
  console.log('🌍 金融市场数据仪表盘');
  console.log('══════════════════════════════════════════════════\n');

  // ---- Macro ----
  if (showAll || cmd === 'macro') {
    console.log('📊 宏观市场指标 (Yahoo Finance)');
    console.log('─────────────────────────────────');
    const quotes = await getYahooQuotes();
    for (const [name, q] of Object.entries(quotes)) {
      if (q.price !== undefined) {
        const icon = arrow(q.change);
        console.log(`  ${name.padEnd(10)} ${fmt(q.price, '$').padEnd(12)} ${icon} ${q.change}`);
      }
    }
    if (quotes['US10Y']?.price && quotes['US2Y']?.price) {
      const spread = (quotes['US10Y'].price - quotes['US2Y'].price).toFixed(3);
      console.log(`\n  2s10s利差: ${spread}% ${parseFloat(spread) < 0 ? '⚠️ 倒挂!' : ''}`);
    }
    console.log();
  }

  // ---- Crypto Prices ----
  if (showAll || cmd === 'crypto') {
    console.log('💰 加密货币价格');
    console.log('─────────────────────────────────');
    const prices = await getCryptoPrices();
    if (prices) {
      for (const [coin, p] of Object.entries(prices)) {
        const extra = p.mcap ? `市值: ${fmt(p.mcap, '$')}` : (p.vol24h ? `24h量: ${p.vol24h}` : '');
        console.log(`  ${coin.padEnd(5)} $${fmt(p.price).padEnd(10)} ${arrow(p.change24h)} ${p.change24h}  ${extra}`);
      }
    }
    console.log();
  }

  // ---- Sentiment ----
  if (showAll || cmd === 'sentiment') {
    console.log('😱 市场情绪');
    console.log('─────────────────────────────────');
    const fg = await getFearGreed();
    if (fg) {
      const bar = '█'.repeat(Math.floor(fg.current.value / 5)) + '░'.repeat(20 - Math.floor(fg.current.value / 5));
      console.log(`  恐惧贪婪指数: ${fg.current.value} [${bar}] ${fg.current.label}`);
      console.log(`  近7天: ${fg.week.map(d => d.value).join(' → ')}`);
    }
    console.log();
  }

  // ---- Funding Rates & OI ----
  if (showAll || cmd === 'funding') {
    console.log('📐 衍生品数据 (OKX Futures)');
    console.log('─────────────────────────────────');
    const funding = await getFundingData();
    for (const [coin, f] of Object.entries(funding)) {
      if (f.error) {
        console.log(`  ${coin}: ⚠️ ${f.error}`);
      } else {
        console.log(`  ${coin.padEnd(5)} 费率: ${f.fundingRate.padEnd(10)} OI: ${f.openInterestUSD || f.openInterest}  标记价: $${f.markPrice}`);
      }
    }
    console.log();
  }

  // ---- Stablecoins ----
  if (showAll || cmd === 'stablecoins') {
    console.log('🏦 稳定币概况 (DefiLlama)');
    console.log('─────────────────────────────────');
    const sc = await getStablecoins();
    if (sc) {
      console.log(`  总市值: ${fmt(sc.totalMcap, '$')}`);
      for (const s of sc.top) {
        console.log(`  ${(s.symbol || s.name).padEnd(8)} ${fmt(s.mcap, '$')}`);
      }
    }
    console.log();
  }

  // ---- Derivatives Deep ----
  if (showAll || cmd === 'derivatives') {
    console.log('🔬 衍生品深度分析 (OKX Rubik)');
    console.log('─────────────────────────────────');
    const deriv = await getDerivativesDeep();

    // Long/Short Ratio
    for (const ccy of ['BTC', 'ETH']) {
      const ls = deriv[`${ccy}_longShort`];
      if (ls) {
        const r = parseFloat(ls.current);
        const signal = r > 3 ? '⚠️ 散户极端看多' : r < 1.5 ? '🟢 散户偏空(反向利多)' : '⚪ 中性';
        const trend = ls.prev8h ? ` (8h前: ${ls.prev8h})` : '';
        console.log(`  ${ccy} 多空比: ${ls.current}:1 ${signal}${trend}`);
      }
    }

    // Margin Lending
    if (deriv.marginLending) {
      const ml = parseFloat(deriv.marginLending.current);
      const signal = ml > 35 ? '⚠️ 杠杆过高' : ml < 15 ? '🟢 杠杆偏低' : '⚪ 适中';
      const trend = deriv.marginLending.prev8h ? ` (8h前: ${deriv.marginLending.prev8h})` : '';
      console.log(`  BTC 杠杆借贷比: ${deriv.marginLending.current} ${signal}${trend}`);
    }

    // Liquidations
    if (deriv.liquidations) {
      const l = deriv.liquidations;
      const dominant = l.longLiq > l.shortLiq ? '多头被爆为主 📉' : '空头被爆为主 📈';
      console.log(`  近期爆仓: 多头 ${l.longLiq.toFixed(2)} BTC (${l.longCount}笔) | 空头 ${l.shortLiq.toFixed(2)} BTC (${l.shortCount}笔) → ${dominant}`);
    }

    // Insurance Fund
    if (deriv.insuranceFund) {
      console.log(`  BTC-USDT 保险基金: ${fmt(deriv.insuranceFund, '$')}`);
    }

    // Funding History
    if (deriv.fundingHistory?.length) {
      const rates = deriv.fundingHistory.map(f => `${f.time}:${f.rate}`).join(' | ');
      const negCount = deriv.fundingHistory.filter(f => f.rate.startsWith('-')).length;
      const signal = negCount >= 4 ? '🟢 持续负费率(空头付费)' : negCount === 0 ? '⚠️ 全正费率' : '';
      console.log(`  BTC 费率趋势(近48h): ${signal}`);
      console.log(`    ${rates}`);
    }

    console.log();
  }

  console.log('─────────────────────────────────');
  console.log(`⏰ ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`);
}

main().catch(e => console.error('Fatal:', e.message));
