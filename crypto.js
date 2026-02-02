#!/usr/bin/env node
/**
 * crypto.js - 加密货币价格查询工具 (CoinGecko API, 完全免费无需 API key)
 * 
 * Usage:
 *   node tools/crypto.js                    # 默认: BTC ETH SOL
 *   node tools/crypto.js btc eth            # 指定币种
 *   node tools/crypto.js bitcoin solana     # 支持全名
 *   node tools/crypto.js --top 10           # Top 10 市值
 * 
 * Features:
 *   - 实时价格（USD + CNY）
 *   - 24h 涨跌幅
 *   - 支持 Top N 市值查询
 *   - 完全免费，无需注册
 */

const https = require('https');

function fetch(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'voltwake-crypto/1.0', 'Accept': 'application/json' } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`JSON parse error: ${data.slice(0, 200)}`)); }
      });
    }).on('error', reject);
  });
}

// 常用缩写映射
const ALIASES = {
  btc: 'bitcoin', eth: 'ethereum', sol: 'solana',
  bnb: 'binancecoin', xrp: 'ripple', ada: 'cardano',
  doge: 'dogecoin', dot: 'polkadot', avax: 'avalanche-2',
  link: 'chainlink', matic: 'matic-network', uni: 'uniswap',
  ton: 'the-open-network', trx: 'tron', ltc: 'litecoin',
  atom: 'cosmos', near: 'near', apt: 'aptos', sui: 'sui',
  arb: 'arbitrum', op: 'optimism', pepe: 'pepe',
};

function resolveId(input) {
  const lower = input.toLowerCase();
  return ALIASES[lower] || lower;
}

function formatPrice(price) {
  if (price >= 1000) return price.toLocaleString('en-US', { maximumFractionDigits: 0 });
  if (price >= 1) return price.toLocaleString('en-US', { maximumFractionDigits: 2 });
  if (price >= 0.01) return price.toLocaleString('en-US', { maximumFractionDigits: 4 });
  return price.toLocaleString('en-US', { maximumFractionDigits: 8 });
}

function formatChange(change) {
  if (change == null) return 'N/A';
  const sign = change >= 0 ? '📈' : '📉';
  const color = change >= 0 ? '+' : '';
  return `${sign} ${color}${change.toFixed(2)}%`;
}

async function getSimplePrice(ids) {
  const url = `https://api.coingecko.com/api/v3/simple/price?ids=${ids.join(',')}&vs_currencies=usd,cny&include_24hr_change=true&include_market_cap=true`;
  return await fetch(url);
}

async function getTopN(n) {
  const url = `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=${n}&page=1&sparkline=false&price_change_percentage=24h`;
  return await fetch(url);
}

async function main() {
  const args = process.argv.slice(2);
  
  // Top N 模式
  if (args[0] === '--top') {
    const n = parseInt(args[1]) || 10;
    const coins = await getTopN(n);
    
    console.log(`\n🏆 加密货币市值 Top ${n}`);
    console.log('═'.repeat(65));
    console.log(`${'#'.padStart(3)}  ${'币种'.padEnd(12)} ${'价格 (USD)'.padStart(14)} ${'24h 变化'.padStart(12)} ${'市值 (B)'.padStart(12)}`);
    console.log('─'.repeat(65));
    
    for (const coin of coins) {
      const rank = String(coin.market_cap_rank).padStart(3);
      const name = `${coin.symbol.toUpperCase()}`.padEnd(12);
      const price = `$${formatPrice(coin.current_price)}`.padStart(14);
      const change = coin.price_change_percentage_24h;
      const changeStr = (change != null ? `${change >= 0 ? '+' : ''}${change.toFixed(2)}%` : 'N/A').padStart(12);
      const mcap = `$${(coin.market_cap / 1e9).toFixed(1)}B`.padStart(12);
      console.log(`${rank}  ${name} ${price} ${changeStr} ${mcap}`);
    }
    console.log('');
    return;
  }
  
  // 普通查询模式
  const ids = args.length > 0 
    ? args.map(resolveId) 
    : ['bitcoin', 'ethereum', 'solana'];
  
  const data = await getSimplePrice(ids);
  
  console.log('\n💰 加密货币实时价格');
  console.log('═'.repeat(50));
  
  for (const id of ids) {
    const coin = data[id];
    if (!coin) {
      console.log(`\n  ❌ ${id}: 未找到`);
      continue;
    }
    
    const symbol = Object.entries(ALIASES).find(([, v]) => v === id)?.[0]?.toUpperCase() || id.toUpperCase();
    console.log(`\n  ${symbol}`);
    console.log(`    USD: $${formatPrice(coin.usd)}  ${formatChange(coin.usd_24h_change)}`);
    console.log(`    CNY: ¥${formatPrice(coin.cny)}  ${formatChange(coin.cny_24h_change)}`);
    if (coin.usd_market_cap) {
      console.log(`    市值: $${(coin.usd_market_cap / 1e9).toFixed(1)}B`);
    }
  }
  console.log('');
}

main().catch(err => {
  console.error(`❌ Error: ${err.message}`);
  process.exit(1);
});
