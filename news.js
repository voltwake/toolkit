#!/usr/bin/env node
/**
 * News Aggregator CLI Tool
 * 一键聚合多源信息：HN + RSS + CoinDesk + 自定义
 * 
 * Usage:
 *   node tools/news.js                        - 全部信息源摘要
 *   node tools/news.js tech [N]               - 科技新闻
 *   node tools/news.js crypto [N]             - 加密货币新闻
 *   node tools/news.js hn [N]                 - Hacker News
 *   node tools/news.js all [N]                - 所有源
 *   node tools/news.js brief                  - 极简摘要（适合 AI agent 消费）
 */

const https = require('https');
const http = require('http');

function fetch(url, redirects = 5) {
  return new Promise((resolve, reject) => {
    if (redirects <= 0) return reject(new Error('Too many redirects'));
    const mod = url.startsWith('https') ? https : http;
    mod.get(url, { headers: { 'User-Agent': 'voltwake-news/1.0' } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        let nextUrl = res.headers.location;
        if (nextUrl.startsWith('/')) {
          const u = new URL(url);
          nextUrl = `${u.protocol}//${u.host}${nextUrl}`;
        }
        return resolve(fetch(nextUrl, redirects - 1));
      }
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

function fetchJSON(url) {
  return fetch(url).then(d => JSON.parse(d));
}

function timeAgo(ts) {
  const now = Date.now();
  const diff = typeof ts === 'number' && ts < 1e12 ? Math.floor(now / 1000) - ts : Math.floor((now - new Date(ts).getTime()) / 1000);
  if (diff < 0) return 'just now';
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function parseRSSItems(xml, count) {
  const items = [];
  const itemRegex = /<item[^>]*>([\s\S]*?)<\/item>|<entry[^>]*>([\s\S]*?)<\/entry>/g;
  let m;
  while ((m = itemRegex.exec(xml)) !== null && items.length < count) {
    const content = m[1] || m[2];
    const getTag = (tag) => {
      const r = content.match(new RegExp(`<${tag}[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${tag}>`));
      return r ? r[1].trim() : '';
    };
    const getLink = () => {
      const linkMatch = content.match(/<link[^>]*href=["']([^"']+)["']/);
      return linkMatch ? linkMatch[1] : getTag('link');
    };
    const title = getTag('title').replace(/<[^>]*>/g, '');
    const link = getLink();
    const date = getTag('pubDate') || getTag('published') || getTag('updated') || '';
    if (title) items.push({ title, link, date });
  }
  return items;
}

// ==================== Sources ====================

async function getHN(count = 5) {
  const ids = await fetchJSON('https://hacker-news.firebaseio.com/v0/topstories.json');
  const stories = await Promise.all(
    ids.slice(0, count).map(id => fetchJSON(`https://hacker-news.firebaseio.com/v0/item/${id}.json`))
  );
  return stories.filter(Boolean).map(s => ({
    title: s.title,
    link: s.url || `https://news.ycombinator.com/item?id=${s.id}`,
    score: s.score,
    comments: s.descendants || 0,
    time: s.time,
    source: 'HN',
  }));
}

async function getRSS(name, url, count = 5) {
  try {
    const xml = await fetch(url);
    const items = parseRSSItems(xml, count);
    return items.map(item => ({
      ...item,
      source: name,
    }));
  } catch {
    return [];
  }
}

async function getJin10(count = 10) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'flash-api.jin10.com',
      path: '/get_flash_list?channel=-8200&vip=1',
      headers: {
        'x-app-id': 'bVBF4FyRTn5NJF5n',
        'x-version': '1.0.0',
        'User-Agent': 'voltwake-news/1.0',
      },
    };
    https.get(options, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (!json.data || !Array.isArray(json.data)) return resolve([]);
          const items = json.data
            .filter(d => d.type === 0 && d.data && d.data.content) // 过滤广告
            .slice(0, count)
            .map(d => {
              // 清理 HTML 标签
              let content = d.data.content.replace(/<[^>]*>/g, '').trim();
              const title = d.data.vip_title || content.substring(0, 80);
              // 提取时分秒 HH:MM
              const timeStr = d.time ? d.time.replace(/^\d{4}-\d{2}-\d{2}\s*/, '').substring(0, 5) : '';
              return {
                title: title,
                link: `https://www.jin10.com/flash_detail/${d.id}.html`,
                date: d.time,
                timeShort: timeStr,
                source: '金十',
                important: d.important === 1,
              };
            });
          resolve(items);
        } catch (e) { resolve([]); }
      });
    }).on('error', () => resolve([]));
  });
}

const SOURCES = {
  tech: [
    { name: 'TechCrunch', url: 'https://techcrunch.com/feed/', type: 'rss' },
    { name: 'HackerNoon', url: 'https://hackernoon.com/feed', type: 'rss' },
    { name: 'HN', type: 'hn' },
  ],
  crypto: [
    { name: 'CoinDesk', url: 'https://www.coindesk.com/arc/outboundfeeds/rss/', type: 'rss' },
    { name: 'TheBlock', url: 'https://www.theblock.co/rss.xml', type: 'rss' },
  ],
  finance: [
    { name: '金十', type: 'jin10' },
  ],
  hn: [
    { name: 'HN', type: 'hn' },
  ],
  jin10: [
    { name: '金十', type: 'jin10' },
  ],
};

SOURCES.all = [...SOURCES.tech, ...SOURCES.crypto, ...SOURCES.finance];

// ==================== Output ====================

function printStory(item, i, brief = false) {
  if (brief) {
    const time = item.timeShort || (item.time ? timeAgo(item.time) : (item.date ? timeAgo(item.date) : ''));
    const imp = item.important ? '🔴 ' : '';
    const meta = [item.source, time, item.score ? `⬆${item.score}` : ''].filter(Boolean).join(' | ');
    console.log(`${i}. ${imp}[${meta}] ${item.title}`);
    return;
  }
  
  const time = item.timeShort || (item.time ? timeAgo(item.time) : (item.date ? timeAgo(item.date) : ''));
  const meta = [];
  if (item.source) meta.push(item.source);
  if (item.timeShort) meta.push(item.timeShort);
  if (item.score) meta.push(`⬆${item.score}`);
  if (item.comments) meta.push(`💬${item.comments}`);
  if (!item.timeShort && time) meta.push(time);
  
  console.log(`${i}. ${item.title}`);
  console.log(`   ${meta.join(' | ')}${item.link ? ' → ' + item.link : ''}`);
  console.log();
}

async function aggregate(category, count, brief) {
  const sources = SOURCES[category];
  if (!sources) {
    console.log(`Unknown category: ${category}. Available: tech, crypto, hn, all`);
    return;
  }
  
  console.log(`\n📰 News — ${category.toUpperCase()}${brief ? ' (brief)' : ''}\n`);
  
  const allItems = [];
  
  for (const src of sources) {
    try {
      if (src.type === 'hn') {
        const items = await getHN(count);
        allItems.push(...items);
      } else if (src.type === 'jin10') {
        const items = await getJin10(count);
        allItems.push(...items);
      } else {
        const items = await getRSS(src.name, src.url, count);
        allItems.push(...items);
      }
    } catch (e) {
      if (!brief) console.log(`  ⚠️ ${src.name}: ${e.message}\n`);
    }
  }
  
  // Deduplicate by title similarity
  const seen = new Set();
  const unique = allItems.filter(item => {
    const key = item.title.toLowerCase().substring(0, 40);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  
  unique.slice(0, count * 2).forEach((item, i) => printStory(item, i + 1, brief));
  
  console.log(`\n--- ${unique.length} stories from ${sources.length} sources ---`);
}

async function main() {
  const [,, cmd, ...args] = process.argv;
  
  if (cmd === '--help' || cmd === '-h') {
    console.log(`
News Aggregator 📰

Usage:
  node tools/news.js                  All sources summary
  node tools/news.js tech [N]         Tech news (TechCrunch, HackerNoon, HN)
  node tools/news.js crypto [N]       Crypto news (CoinDesk, TheBlock)
  node tools/news.js finance [N]      金融快讯 (金十财经)
  node tools/news.js jin10 [N]        金十财经快讯
  node tools/news.js hn [N]           Hacker News only
  node tools/news.js all [N]          Everything
  node tools/news.js brief            Compact format for AI agent consumption

Sources: TechCrunch, HackerNoon, HN, CoinDesk, TheBlock, 金十财经
`);
    return;
  }
  
  const allArgs = [cmd, ...args];
  const brief = allArgs.includes('brief');
  const count = parseInt(allArgs.find(a => /^\d+$/.test(a))) || 5;
  const category = allArgs.find(a => a && a !== 'brief' && !/^\d+$/.test(a)) || 'all';
  
  try {
    await aggregate(category, count, brief);
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
}

main();
