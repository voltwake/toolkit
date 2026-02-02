#!/usr/bin/env node
/**
 * Price Alert Monitor CLI Tool
 * 加密货币价格监控告警系统
 * 
 * Usage:
 *   node tools/alert.js set BTC below 75000        - BTC 跌破 $75,000 时告警
 *   node tools/alert.js set ETH above 2500          - ETH 突破 $2,500 时告警
 *   node tools/alert.js set BTC change 5            - BTC 24h 涨跌超 5% 时告警
 *   node tools/alert.js list                        - 列出所有告警
 *   node tools/alert.js check                       - 检查所有告警（返回触发的）
 *   node tools/alert.js remove <id>                 - 删除告警
 *   node tools/alert.js clear                       - 清除所有告警
 *   node tools/alert.js history [N]                 - 查看最近 N 条触发记录
 * 
 * Config: ~/.config/alerts/config.json
 * History: ~/.config/alerts/history.json
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

const CONFIG_DIR = path.join(process.env.HOME || process.env.USERPROFILE, '.config', 'alerts');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const HISTORY_FILE = path.join(CONFIG_DIR, 'history.json');

// Common coin name → CoinGecko ID mapping
const COIN_MAP = {
  btc: 'bitcoin', bitcoin: 'bitcoin',
  eth: 'ethereum', ethereum: 'ethereum',
  sol: 'solana', solana: 'solana',
  bnb: 'binancecoin',
  xrp: 'ripple', ripple: 'ripple',
  doge: 'dogecoin', dogecoin: 'dogecoin',
  ada: 'cardano', cardano: 'cardano',
  avax: 'avalanche-2',
  dot: 'polkadot', polkadot: 'polkadot',
  matic: 'matic-network', polygon: 'matic-network',
  link: 'chainlink', chainlink: 'chainlink',
  uni: 'uniswap', uniswap: 'uniswap',
  atom: 'cosmos', cosmos: 'cosmos',
  ltc: 'litecoin', litecoin: 'litecoin',
  ton: 'the-open-network',
  trx: 'tron', tron: 'tron',
  shib: 'shiba-inu',
  apt: 'aptos', aptos: 'aptos',
  sui: 'sui',
  arb: 'arbitrum', arbitrum: 'arbitrum',
  op: 'optimism', optimism: 'optimism',
  pepe: 'pepe',
};

function ensureDir() {
  if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
}

function loadConfig() {
  ensureDir();
  if (!fs.existsSync(CONFIG_FILE)) return { alerts: [] };
  return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
}

function saveConfig(config) {
  ensureDir();
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

function loadHistory() {
  ensureDir();
  if (!fs.existsSync(HISTORY_FILE)) return [];
  return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf-8'));
}

function saveHistory(history) {
  ensureDir();
  // Keep last 200 entries
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(history.slice(-200), null, 2));
}

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'voltwake-alert/1.0' } }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`Parse error: ${data.substring(0, 200)}`)); }
      });
    }).on('error', reject);
  });
}

function resolveCoins(alerts) {
  const ids = new Set();
  for (const a of alerts) {
    const id = COIN_MAP[a.coin.toLowerCase()] || a.coin.toLowerCase();
    ids.add(id);
  }
  return [...ids];
}

async function fetchPrices(coinIds) {
  const ids = coinIds.join(',');
  const url = `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd,cny&include_24hr_change=true`;
  return fetchJSON(url);
}

function generateId() {
  return Math.random().toString(36).substring(2, 8);
}

// ==================== Commands ====================

function cmdSet(args) {
  if (args.length < 3) {
    console.log('Usage: node tools/alert.js set <COIN> <above|below|change> <value>');
    console.log('Examples:');
    console.log('  set BTC below 75000     — BTC 跌破 $75,000');
    console.log('  set ETH above 2500      — ETH 突破 $2,500');
    console.log('  set SOL change 10       — SOL 24h 涨跌超 10%');
    return;
  }

  const coin = args[0].toUpperCase();
  const condition = args[1].toLowerCase();
  const value = parseFloat(args[2]);

  if (!['above', 'below', 'change'].includes(condition)) {
    console.log('条件必须是 above, below, 或 change');
    return;
  }
  if (isNaN(value)) {
    console.log('值必须是数字');
    return;
  }

  const coinId = COIN_MAP[coin.toLowerCase()] || coin.toLowerCase();
  const config = loadConfig();
  const alert = {
    id: generateId(),
    coin: coin,
    coinId: coinId,
    condition: condition,
    value: value,
    createdAt: new Date().toISOString(),
    triggered: false,
    triggerCount: 0,
    repeat: true, // 默认可重复触发
    cooldownMinutes: 60, // 触发后冷却时间
    lastTriggeredAt: null,
  };

  config.alerts.push(alert);
  saveConfig(config);

  const desc = condition === 'change' 
    ? `${coin} 24h 涨跌幅超 ±${value}%` 
    : `${coin} ${condition === 'above' ? '突破' : '跌破'} $${value.toLocaleString()}`;
  
  console.log(`✅ 告警已设置 [${alert.id}]: ${desc}`);
}

function cmdList() {
  const config = loadConfig();
  if (config.alerts.length === 0) {
    console.log('📭 没有活跃的告警');
    return;
  }

  console.log(`\n🔔 活跃告警 (${config.alerts.length} 个)\n`);
  for (const a of config.alerts) {
    const desc = a.condition === 'change'
      ? `${a.coin} 24h ±${a.value}%`
      : `${a.coin} ${a.condition === 'above' ? '↑' : '↓'} $${a.value.toLocaleString()}`;
    const status = a.lastTriggeredAt 
      ? `上次触发: ${new Date(a.lastTriggeredAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`
      : '未触发';
    console.log(`  [${a.id}] ${desc}  |  触发${a.triggerCount}次  |  ${status}`);
  }
  console.log();
}

async function cmdCheck() {
  const config = loadConfig();
  if (config.alerts.length === 0) {
    console.log('📭 没有告警需要检查');
    return;
  }

  const coinIds = resolveCoins(config.alerts);
  let prices;
  try {
    prices = await fetchPrices(coinIds);
  } catch (e) {
    console.error('获取价格失败:', e.message);
    return;
  }

  const now = Date.now();
  const triggered = [];
  const history = loadHistory();

  for (const alert of config.alerts) {
    const coinId = COIN_MAP[alert.coin.toLowerCase()] || alert.coin.toLowerCase();
    const priceData = prices[coinId];
    if (!priceData) continue;

    const price = priceData.usd;
    const priceCNY = priceData.cny;
    const change24h = priceData.usd_24h_change;

    // 检查冷却期
    if (alert.lastTriggeredAt) {
      const cooldown = (alert.cooldownMinutes || 60) * 60 * 1000;
      if (now - new Date(alert.lastTriggeredAt).getTime() < cooldown) continue;
    }

    let fired = false;
    let message = '';

    if (alert.condition === 'above' && price >= alert.value) {
      fired = true;
      message = `🔴 ${alert.coin} 突破 $${alert.value.toLocaleString()}！当前 $${price.toLocaleString()} (¥${priceCNY?.toLocaleString()})`;
    } else if (alert.condition === 'below' && price <= alert.value) {
      fired = true;
      message = `🔴 ${alert.coin} 跌破 $${alert.value.toLocaleString()}！当前 $${price.toLocaleString()} (¥${priceCNY?.toLocaleString()})`;
    } else if (alert.condition === 'change' && Math.abs(change24h) >= alert.value) {
      fired = true;
      const dir = change24h > 0 ? '📈 暴涨' : '📉 暴跌';
      message = `${dir} ${alert.coin} 24h ${change24h > 0 ? '+' : ''}${change24h.toFixed(2)}%！当前 $${price.toLocaleString()} (¥${priceCNY?.toLocaleString()})`;
    }

    if (fired) {
      alert.triggered = true;
      alert.triggerCount++;
      alert.lastTriggeredAt = new Date().toISOString();
      
      triggered.push({
        alertId: alert.id,
        coin: alert.coin,
        condition: alert.condition,
        threshold: alert.value,
        currentPrice: price,
        currentPriceCNY: priceCNY,
        change24h: change24h,
        message: message,
        time: new Date().toISOString(),
      });

      history.push({
        alertId: alert.id,
        message: message,
        time: new Date().toISOString(),
      });
    }
  }

  saveConfig(config);
  saveHistory(history);

  if (triggered.length === 0) {
    // 输出当前价格摘要
    console.log('✅ 无告警触发\n');
    console.log('当前价格:');
    for (const id of coinIds) {
      const p = prices[id];
      if (!p) continue;
      const name = Object.entries(COIN_MAP).find(([k, v]) => v === id)?.[0]?.toUpperCase() || id;
      const change = p.usd_24h_change;
      const arrow = change >= 0 ? '↑' : '↓';
      console.log(`  ${name}: $${p.usd?.toLocaleString()} (¥${p.cny?.toLocaleString()}) ${arrow}${Math.abs(change).toFixed(2)}%`);
    }
  } else {
    console.log(`\n⚠️ ${triggered.length} 个告警触发！\n`);
    for (const t of triggered) {
      console.log(t.message);
    }
  }
  console.log();
}

function cmdRemove(args) {
  if (args.length < 1) {
    console.log('Usage: node tools/alert.js remove <id>');
    return;
  }
  const id = args[0];
  const config = loadConfig();
  const before = config.alerts.length;
  config.alerts = config.alerts.filter(a => a.id !== id);
  saveConfig(config);

  if (config.alerts.length < before) {
    console.log(`🗑️ 告警 [${id}] 已删除`);
  } else {
    console.log(`❌ 未找到告警 [${id}]`);
  }
}

function cmdClear() {
  saveConfig({ alerts: [] });
  console.log('🗑️ 所有告警已清除');
}

function cmdHistory(args) {
  const count = parseInt(args[0]) || 10;
  const history = loadHistory();
  if (history.length === 0) {
    console.log('📭 无触发记录');
    return;
  }

  console.log(`\n📋 最近 ${Math.min(count, history.length)} 条触发记录\n`);
  const recent = history.slice(-count).reverse();
  for (const h of recent) {
    const time = new Date(h.time).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
    console.log(`  ${time} | ${h.message}`);
  }
  console.log();
}

// ==================== Main ====================

async function main() {
  const [,, cmd, ...args] = process.argv;

  if (!cmd || cmd === '--help' || cmd === '-h') {
    console.log(`
🔔 Price Alert Monitor

Usage:
  node tools/alert.js set <COIN> <above|below|change> <value>
  node tools/alert.js list                    列出所有告警
  node tools/alert.js check                   检查告警（用于 cron）
  node tools/alert.js remove <id>             删除告警
  node tools/alert.js clear                   清除所有
  node tools/alert.js history [N]             触发历史

Examples:
  set BTC below 75000       BTC 跌破 $75,000
  set ETH above 3000        ETH 突破 $3,000
  set SOL change 10         SOL 24h 涨跌超 ±10%

Supported: BTC ETH SOL BNB XRP DOGE ADA AVAX DOT LINK UNI ATOM LTC TON TRX SHIB APT SUI ARB OP PEPE
`);
    return;
  }

  switch (cmd) {
    case 'set': cmdSet(args); break;
    case 'list': cmdList(); break;
    case 'check': await cmdCheck(); break;
    case 'remove': cmdRemove(args); break;
    case 'clear': cmdClear(); break;
    case 'history': cmdHistory(args); break;
    default:
      console.log(`未知命令: ${cmd}。用 --help 查看帮助`);
  }
}

main().catch(e => { console.error('Error:', e.message); process.exit(1); });
