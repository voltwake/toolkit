#!/usr/bin/env node
/**
 * Crypto Exchange CLI Tool (powered by CCXT)
 * 统一访问 100+ 加密货币交易所的行情数据
 * 
 * Usage:
 *   node tools/exchange.js price <symbol> [exchange]     - 获取价格 (默认 binance)
 *   node tools/exchange.js ticker <symbol> [exchange]    - 完整 ticker 信息
 *   node tools/exchange.js orderbook <symbol> [exchange] - 订单簿 top 5
 *   node tools/exchange.js ohlcv <symbol> [timeframe] [exchange] - K线数据
 *   node tools/exchange.js markets [exchange]            - 列出交易对
 *   node tools/exchange.js exchanges                     - 列出所有支持的交易所
 *   node tools/exchange.js compare <symbol>              - 跨交易所比价
 *   node tools/exchange.js funding <symbol>              - 资金费率 (永续合约)
 * 
 * Examples:
 *   node tools/exchange.js price BTC/USDT
 *   node tools/exchange.js price ETH/USDT okx
 *   node tools/exchange.js compare BTC/USDT
 *   node tools/exchange.js ohlcv BTC/USDT 1h binance
 */

const ccxt = require('ccxt');

function formatNum(n, decimals = 2) {
  if (n == null) return 'N/A';
  if (Math.abs(n) >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (Math.abs(n) >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (Math.abs(n) >= 1e3) return (n / 1e3).toFixed(2) + 'K';
  return n.toFixed(decimals);
}

function formatPrice(n) {
  if (n == null) return 'N/A';
  if (n >= 1) return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (n >= 0.01) return n.toFixed(4);
  return n.toFixed(8);
}

function getExchange(name = 'binance') {
  name = name.toLowerCase();
  if (!ccxt.exchanges.includes(name)) {
    throw new Error(`Exchange "${name}" not found. Run "exchanges" to see available ones.`);
  }
  return new ccxt[name]({ enableRateLimit: true });
}

async function price(symbol, exchangeName) {
  const exchange = getExchange(exchangeName);
  const ticker = await exchange.fetchTicker(symbol);
  
  const change = ticker.percentage != null ? `${ticker.percentage >= 0 ? '+' : ''}${ticker.percentage.toFixed(2)}%` : '';
  const vol = ticker.quoteVolume ? `Vol: $${formatNum(ticker.quoteVolume)}` : '';
  
  console.log(`\n💰 ${symbol} @ ${exchange.name}`);
  console.log(`Price: $${formatPrice(ticker.last)} ${change}`);
  console.log(`High: $${formatPrice(ticker.high)}  Low: $${formatPrice(ticker.low)}`);
  if (vol) console.log(vol);
}

async function ticker(symbol, exchangeName) {
  const exchange = getExchange(exchangeName);
  const t = await exchange.fetchTicker(symbol);
  
  console.log(`\n📊 ${symbol} @ ${exchange.name}\n`);
  console.log(`Last:     $${formatPrice(t.last)}`);
  console.log(`Bid:      $${formatPrice(t.bid)} (size: ${t.bidVolume || 'N/A'})`);
  console.log(`Ask:      $${formatPrice(t.ask)} (size: ${t.askVolume || 'N/A'})`);
  console.log(`Open:     $${formatPrice(t.open)}`);
  console.log(`High:     $${formatPrice(t.high)}`);
  console.log(`Low:      $${formatPrice(t.low)}`);
  console.log(`Change:   ${t.percentage != null ? t.percentage.toFixed(2) + '%' : 'N/A'} ($${formatPrice(t.change)})`);
  console.log(`Volume:   ${formatNum(t.baseVolume)} ${symbol.split('/')[0]}`);
  console.log(`Turnover: $${formatNum(t.quoteVolume)}`);
  console.log(`VWAP:     $${formatPrice(t.vwap)}`);
  console.log(`Time:     ${new Date(t.timestamp).toISOString()}`);
}

async function orderbook(symbol, exchangeName) {
  const exchange = getExchange(exchangeName);
  const book = await exchange.fetchOrderBook(symbol, 5);
  
  console.log(`\n📗 Order Book: ${symbol} @ ${exchange.name}\n`);
  console.log('  ASKS (sell orders):');
  [...book.asks].reverse().forEach(([price, amount]) => {
    console.log(`    $${formatPrice(price)}  |  ${amount}`);
  });
  console.log('  ------- spread -------');
  book.bids.forEach(([price, amount]) => {
    console.log(`    $${formatPrice(price)}  |  ${amount}`);
  });
  console.log('  BIDS (buy orders)');
  
  if (book.asks.length && book.bids.length) {
    const spread = book.asks[0][0] - book.bids[0][0];
    const spreadPct = (spread / book.asks[0][0] * 100).toFixed(4);
    console.log(`\n  Spread: $${formatPrice(spread)} (${spreadPct}%)`);
  }
}

async function ohlcv(symbol, timeframe = '1h', exchangeName = 'binance') {
  const exchange = getExchange(exchangeName);
  if (!exchange.has['fetchOHLCV']) {
    console.log(`${exchange.name} does not support OHLCV data`);
    return;
  }
  const candles = await exchange.fetchOHLCV(symbol, timeframe, undefined, 20);
  
  console.log(`\n📈 ${symbol} ${timeframe} candles @ ${exchange.name} (last 20)\n`);
  console.log('  Time                  | Open      | High      | Low       | Close     | Volume');
  console.log('  ' + '-'.repeat(90));
  
  candles.forEach(([ts, o, h, l, c, v]) => {
    const time = new Date(ts).toISOString().replace('T', ' ').substring(0, 16);
    const dir = c >= o ? '🟢' : '🔴';
    console.log(`  ${time} ${dir} | ${formatPrice(o).padStart(9)} | ${formatPrice(h).padStart(9)} | ${formatPrice(l).padStart(9)} | ${formatPrice(c).padStart(9)} | ${formatNum(v)}`);
  });
}

async function markets(exchangeName) {
  const exchange = getExchange(exchangeName);
  await exchange.loadMarkets();
  const symbols = Object.keys(exchange.markets).sort();
  
  console.log(`\n🏪 ${exchange.name}: ${symbols.length} trading pairs\n`);
  
  // Show USDT pairs as they're most common
  const usdtPairs = symbols.filter(s => s.endsWith('/USDT'));
  console.log(`USDT pairs (${usdtPairs.length}): ${usdtPairs.slice(0, 30).join(', ')}${usdtPairs.length > 30 ? '...' : ''}`);
}

function exchanges() {
  console.log(`\n🏦 Supported Exchanges (${ccxt.exchanges.length} total)\n`);
  
  const popular = ['binance', 'okx', 'bybit', 'coinbase', 'kraken', 'bitget', 'gate', 'kucoin', 'huobi', 'mexc', 'bitfinex', 'bitstamp', 'crypto.com'];
  const available = popular.filter(e => ccxt.exchanges.includes(e));
  
  console.log('Popular:');
  available.forEach(e => console.log(`  ✅ ${e}`));
  console.log(`\nAll: ${ccxt.exchanges.join(', ')}`);
}

async function compare(symbol) {
  const exchangeNames = ['binance', 'okx', 'bybit', 'kraken', 'kucoin', 'bitget', 'gate'];
  
  console.log(`\n⚖️ Cross-exchange comparison: ${symbol}\n`);
  
  const results = [];
  for (const name of exchangeNames) {
    try {
      const ex = getExchange(name);
      const t = await ex.fetchTicker(symbol);
      results.push({
        exchange: ex.name,
        price: t.last,
        volume: t.quoteVolume,
        change: t.percentage,
      });
    } catch (e) {
      // Skip exchanges that don't have this pair
    }
  }
  
  if (results.length === 0) {
    console.log('No exchanges found with this trading pair.');
    return;
  }
  
  results.sort((a, b) => (a.price || 0) - (b.price || 0));
  const min = results[0].price;
  const max = results[results.length - 1].price;
  
  results.forEach(r => {
    const vol = r.volume ? `Vol: $${formatNum(r.volume)}` : '';
    const chg = r.change != null ? `${r.change >= 0 ? '+' : ''}${r.change.toFixed(2)}%` : '';
    console.log(`  ${r.exchange.padEnd(12)} $${formatPrice(r.price)}  ${chg.padEnd(8)}  ${vol}`);
  });
  
  if (min && max) {
    const diff = ((max - min) / min * 100).toFixed(4);
    console.log(`\n  Spread: ${diff}% ($${formatPrice(max - min)})`);
    console.log(`  Lowest:  ${results[0].exchange}`);
    console.log(`  Highest: ${results[results.length - 1].exchange}`);
  }
}

async function main() {
  const [,, cmd, ...args] = process.argv;
  
  if (!cmd || cmd === '--help' || cmd === '-h') {
    console.log(`
Crypto Exchange CLI (CCXT) ₿

Usage:
  node tools/exchange.js price <symbol> [exchange]      Get price (default: binance)
  node tools/exchange.js ticker <symbol> [exchange]     Full ticker info
  node tools/exchange.js orderbook <symbol> [exchange]  Order book (top 5)
  node tools/exchange.js ohlcv <symbol> [tf] [exchange] OHLCV candles
  node tools/exchange.js markets [exchange]             List trading pairs
  node tools/exchange.js exchanges                      List all exchanges
  node tools/exchange.js compare <symbol>               Cross-exchange price compare

Examples:
  node tools/exchange.js price BTC/USDT
  node tools/exchange.js compare ETH/USDT
  node tools/exchange.js ohlcv BTC/USDT 1h okx
`);
    return;
  }
  
  try {
    switch (cmd) {
      case 'price':
        await price(args[0], args[1] || 'binance');
        break;
      case 'ticker':
        await ticker(args[0], args[1] || 'binance');
        break;
      case 'orderbook': case 'book':
        await orderbook(args[0], args[1] || 'binance');
        break;
      case 'ohlcv': case 'candles': case 'kline':
        await ohlcv(args[0], args[1] || '1h', args[2] || 'binance');
        break;
      case 'markets':
        await markets(args[0] || 'binance');
        break;
      case 'exchanges':
        exchanges();
        break;
      case 'compare': case 'cmp':
        await compare(args[0]);
        break;
      default:
        console.log(`Unknown command: ${cmd}. Run with --help for usage.`);
    }
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
}

main();
