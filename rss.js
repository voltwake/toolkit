#!/usr/bin/env node
/**
 * RSS Feed Reader CLI Tool v2
 * 纯 Node.js 实现，支持 RSS/Atom 解析 + RSS 自动发现
 * 
 * Usage:
 *   node tools/rss.js <url> [N]                - Read a feed URL (N items, default 10)
 *   node tools/rss.js list                     - List saved feeds
 *   node tools/rss.js add <name> <url>         - Save a feed
 *   node tools/rss.js remove <name>            - Remove a saved feed
 *   node tools/rss.js read <name> [N]          - Read a saved feed
 *   node tools/rss.js all [N]                  - Read all saved feeds
 *   node tools/rss.js discover <url>           - Auto-discover RSS feeds on a website
 *   node tools/rss.js search <query>           - Search for feeds (via Feedsearch)
 * 
 * Saved feeds stored in: ~/.config/rss/feeds.json
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

const FEEDS_FILE = path.join(process.env.HOME || process.env.USERPROFILE, '.config', 'rss', 'feeds.json');

// Default feeds (useful tech/crypto/AI sources)
const DEFAULT_FEEDS = {
  'hn': 'https://hnrss.org/frontpage',
  'coindesk': 'https://www.coindesk.com/arc/outboundfeeds/rss/',
  'techcrunch-ai': 'https://techcrunch.com/category/artificial-intelligence/feed/',
  'theblock': 'https://www.theblock.co/rss.xml',
  'hackernoon': 'https://hackernoon.com/feed',
};

function fetch(url, redirects = 5) {
  return new Promise((resolve, reject) => {
    if (redirects <= 0) return reject(new Error('Too many redirects'));
    const mod = url.startsWith('https') ? https : http;
    mod.get(url, { headers: { 'User-Agent': 'voltwake-rss/1.0' } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        let nextUrl = res.headers.location;
        // Handle relative redirects
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

function parseXML(xml) {
  // Simple RSS/Atom parser without dependencies
  const items = [];
  const isAtom = xml.includes('<feed') && xml.includes('xmlns="http://www.w3.org/2005/Atom"');
  
  // Get feed title
  const feedTitleMatch = xml.match(/<title[^>]*>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>/);
  const feedTitle = feedTitleMatch ? feedTitleMatch[1].trim() : 'Unknown Feed';
  
  // Parse items (RSS) or entries (Atom)
  const itemTag = isAtom ? 'entry' : 'item';
  const itemRegex = new RegExp(`<${itemTag}[^>]*>([\\s\\S]*?)<\\/${itemTag}>`, 'g');
  let match;
  
  while ((match = itemRegex.exec(xml)) !== null) {
    const content = match[1];
    
    const getTag = (tag) => {
      const m = content.match(new RegExp(`<${tag}[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${tag}>`));
      return m ? m[1].trim() : '';
    };
    
    const getLink = () => {
      if (isAtom) {
        const m = content.match(/<link[^>]*href=["']([^"']+)["'][^>]*\/?>/);
        return m ? m[1] : '';
      }
      return getTag('link');
    };
    
    const getDate = () => {
      return getTag('pubDate') || getTag('published') || getTag('updated') || getTag('dc:date') || '';
    };
    
    const title = getTag('title');
    const link = getLink();
    const date = getDate();
    const description = getTag('description') || getTag('summary') || getTag('content');
    const author = getTag('author') || getTag('dc:creator') || '';
    
    items.push({
      title: title.replace(/<[^>]*>/g, ''),
      link,
      date,
      description: description.replace(/<[^>]*>/g, '').substring(0, 200),
      author: author.replace(/<[^>]*>/g, ''),
    });
  }
  
  return { title: feedTitle, items };
}

function formatDate(dateStr) {
  if (!dateStr) return '';
  try {
    const d = new Date(dateStr);
    const now = new Date();
    const diffMs = now - d;
    const diffH = Math.floor(diffMs / 3600000);
    if (diffH < 1) return `${Math.floor(diffMs / 60000)}m ago`;
    if (diffH < 24) return `${diffH}h ago`;
    if (diffH < 168) return `${Math.floor(diffH / 24)}d ago`;
    return d.toISOString().split('T')[0];
  } catch {
    return dateStr.substring(0, 16);
  }
}

function loadFeeds() {
  try {
    return JSON.parse(fs.readFileSync(FEEDS_FILE, 'utf8'));
  } catch {
    return { ...DEFAULT_FEEDS };
  }
}

function saveFeeds(feeds) {
  const dir = path.dirname(FEEDS_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(FEEDS_FILE, JSON.stringify(feeds, null, 2));
}

async function readFeed(url, count = 10) {
  console.log(`Fetching ${url}...`);
  const xml = await fetch(url);
  const { title, items } = parseXML(xml);
  
  console.log(`\n📡 ${title} (${items.length} items, showing ${Math.min(count, items.length)})\n`);
  
  items.slice(0, count).forEach((item, i) => {
    const date = formatDate(item.date);
    const author = item.author ? ` | @${item.author}` : '';
    console.log(`${i + 1}. ${item.title}`);
    console.log(`   ${[date, item.link].filter(Boolean).join(' | ')}${author}`);
    if (item.description) {
      console.log(`   ${item.description.substring(0, 120)}${item.description.length > 120 ? '...' : ''}`);
    }
    console.log();
  });
  
  return { title, items };
}

async function discoverFeeds(url) {
  console.log(`🔍 Discovering RSS feeds on ${url}...\n`);
  const html = await fetch(url);
  const feeds = [];
  
  // Method 1: Look for <link> tags with RSS/Atom type
  const linkRegex = /<link[^>]*type=["'](application\/rss\+xml|application\/atom\+xml|application\/feed\+json)["'][^>]*>/gi;
  let m;
  while ((m = linkRegex.exec(html)) !== null) {
    const tag = m[0];
    const hrefMatch = tag.match(/href=["']([^"']+)["']/);
    const titleMatch = tag.match(/title=["']([^"']+)["']/);
    if (hrefMatch) {
      let feedUrl = hrefMatch[1];
      if (feedUrl.startsWith('/')) {
        try { feedUrl = new URL(feedUrl, url).href; } catch {}
      }
      feeds.push({
        url: feedUrl,
        title: titleMatch ? titleMatch[1] : 'Untitled',
        type: m[1],
      });
    }
  }
  
  // Method 2: Common RSS paths to try
  const commonPaths = ['/feed', '/rss', '/rss.xml', '/feed.xml', '/atom.xml', '/feeds/posts/default', '/blog/rss', '/index.xml'];
  const baseUrl = new URL(url);
  
  for (const p of commonPaths) {
    try {
      const testUrl = `${baseUrl.protocol}//${baseUrl.host}${p}`;
      const resp = await fetch(testUrl);
      if (resp.includes('<rss') || resp.includes('<feed') || resp.includes('<channel>')) {
        const titleMatch = resp.match(/<title[^>]*>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>/);
        if (!feeds.some(f => f.url === testUrl)) {
          feeds.push({
            url: testUrl,
            title: titleMatch ? titleMatch[1].trim() : 'Discovered',
            type: resp.includes('<feed') ? 'atom' : 'rss',
          });
        }
      }
    } catch {}
  }
  
  if (feeds.length === 0) {
    console.log('❌ No RSS feeds found on this site.');
    console.log('Tip: Try adding /feed, /rss, or /rss.xml to the URL manually.');
    return;
  }
  
  console.log(`✅ Found ${feeds.length} feed(s):\n`);
  feeds.forEach((f, i) => {
    console.log(`  ${i + 1}. ${f.title}`);
    console.log(`     ${f.url}`);
    console.log(`     Type: ${f.type}\n`);
  });
}

async function main() {
  const [,, cmd, ...args] = process.argv;
  
  if (!cmd || cmd === '--help' || cmd === '-h') {
    console.log(`
RSS Feed Reader v2 📡

Usage:
  node tools/rss.js <url> [N]           Read a feed URL (N items, default 10)
  node tools/rss.js list                List saved feeds
  node tools/rss.js add <name> <url>    Save a feed
  node tools/rss.js remove <name>       Remove a saved feed
  node tools/rss.js read <name> [N]     Read a saved feed
  node tools/rss.js all [N]             Read all saved feeds
  node tools/rss.js discover <url>      Auto-discover RSS feeds on a site

Default feeds: ${Object.keys(DEFAULT_FEEDS).join(', ')}
`);
    return;
  }
  
  try {
    if (cmd === 'list') {
      const feeds = loadFeeds();
      console.log('\n📋 Saved Feeds:\n');
      Object.entries(feeds).forEach(([name, url]) => {
        console.log(`  ${name}: ${url}`);
      });
      return;
    }
    
    if (cmd === 'add') {
      if (args.length < 2) return console.log('Usage: node tools/rss.js add <name> <url>');
      const feeds = loadFeeds();
      feeds[args[0]] = args[1];
      saveFeeds(feeds);
      console.log(`✅ Added feed "${args[0]}": ${args[1]}`);
      return;
    }
    
    if (cmd === 'remove') {
      if (!args[0]) return console.log('Usage: node tools/rss.js remove <name>');
      const feeds = loadFeeds();
      delete feeds[args[0]];
      saveFeeds(feeds);
      console.log(`🗑️ Removed feed "${args[0]}"`);
      return;
    }
    
    if (cmd === 'read') {
      if (!args[0]) return console.log('Usage: node tools/rss.js read <name> [N]');
      const feeds = loadFeeds();
      const url = feeds[args[0]];
      if (!url) return console.log(`Feed "${args[0]}" not found. Run 'list' to see available feeds.`);
      await readFeed(url, parseInt(args[1]) || 10);
      return;
    }
    
    if (cmd === 'all') {
      const feeds = loadFeeds();
      const count = parseInt(args[0]) || 5;
      for (const [name, url] of Object.entries(feeds)) {
        console.log(`\n${'='.repeat(60)}`);
        console.log(`📌 ${name}`);
        try {
          await readFeed(url, count);
        } catch (err) {
          console.log(`  ❌ Error: ${err.message}`);
        }
      }
      return;
    }
    
    if (cmd === 'discover') {
      if (!args[0]) return console.log('Usage: node tools/rss.js discover <website-url>');
      let discoverUrl = args[0];
      if (!discoverUrl.startsWith('http')) discoverUrl = 'https://' + discoverUrl;
      await discoverFeeds(discoverUrl);
      return;
    }
    
    // Direct URL
    if (cmd.startsWith('http')) {
      await readFeed(cmd, parseInt(args[0]) || 10);
      return;
    }
    
    // Try as saved feed name
    const feeds = loadFeeds();
    if (feeds[cmd]) {
      await readFeed(feeds[cmd], parseInt(args[0]) || 10);
      return;
    }
    
    console.log(`Unknown command or feed: ${cmd}. Run with --help for usage.`);
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
}

main();
