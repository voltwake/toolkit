#!/usr/bin/env node
/**
 * Hacker News CLI Tool
 * API: Official HN Firebase API (https://hacker-news.firebaseio.com)
 * 完全免费，无需 key
 * 
 * Usage:
 *   node tools/hn.js top [N]        - Top stories (default 10)
 *   node tools/hn.js new [N]        - Newest stories
 *   node tools/hn.js best [N]       - Best stories
 *   node tools/hn.js ask [N]        - Ask HN
 *   node tools/hn.js show [N]       - Show HN
 *   node tools/hn.js jobs [N]       - Job postings
 *   node tools/hn.js item <id>      - Get item details (story/comment)
 *   node tools/hn.js user <id>      - Get user info
 *   node tools/hn.js search <query> - Search stories (Algolia API)
 */

const https = require('https');

const HN_API = 'https://hacker-news.firebaseio.com/v0';
const ALGOLIA_API = 'https://hn.algolia.com/api/v1';

function fetch(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : require('http');
    mod.get(url, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve(data); }
      });
    }).on('error', reject);
  });
}

function timeAgo(ts) {
  const diff = Math.floor(Date.now() / 1000) - ts;
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

async function getStories(type, count) {
  const endpoints = {
    top: 'topstories',
    new: 'newstories',
    best: 'beststories',
    ask: 'askstories',
    show: 'showstories',
    jobs: 'jobstories'
  };
  const endpoint = endpoints[type] || 'topstories';
  const ids = await fetch(`${HN_API}/${endpoint}.json`);
  const items = await Promise.all(
    ids.slice(0, count).map(id => fetch(`${HN_API}/item/${id}.json`))
  );
  
  console.log(`\n📰 Hacker News — ${type.toUpperCase()} (${count} stories)\n`);
  items.forEach((item, i) => {
    if (!item) return;
    const url = item.url ? ` → ${item.url}` : '';
    const score = item.score ? `⬆${item.score}` : '';
    const comments = item.descendants != null ? `💬${item.descendants}` : '';
    const by = item.by ? `@${item.by}` : '';
    const time = item.time ? timeAgo(item.time) : '';
    console.log(`${i + 1}. ${item.title}`);
    console.log(`   ${[score, comments, by, time].filter(Boolean).join(' | ')}${url}`);
    console.log();
  });
}

async function getItem(id) {
  const item = await fetch(`${HN_API}/item/${id}.json`);
  if (!item) return console.log('Item not found');
  
  console.log(`\n📄 Item #${id}\n`);
  console.log(`Type: ${item.type}`);
  if (item.title) console.log(`Title: ${item.title}`);
  if (item.url) console.log(`URL: ${item.url}`);
  if (item.text) console.log(`Text: ${item.text.replace(/<[^>]*>/g, '')}`);
  if (item.by) console.log(`By: ${item.by}`);
  if (item.score) console.log(`Score: ${item.score}`);
  if (item.descendants != null) console.log(`Comments: ${item.descendants}`);
  if (item.time) console.log(`Time: ${timeAgo(item.time)}`);
  if (item.kids && item.kids.length > 0) {
    console.log(`\n--- Top Comments ---`);
    const topComments = await Promise.all(
      item.kids.slice(0, 5).map(kid => fetch(`${HN_API}/item/${kid}.json`))
    );
    topComments.forEach(c => {
      if (!c || c.deleted || c.dead) return;
      const text = (c.text || '').replace(/<[^>]*>/g, '').substring(0, 200);
      console.log(`\n  @${c.by} (${timeAgo(c.time)}):`);
      console.log(`  ${text}${text.length >= 200 ? '...' : ''}`);
    });
  }
}

async function getUser(id) {
  const user = await fetch(`${HN_API}/user/${id}.json`);
  if (!user) return console.log('User not found');
  
  console.log(`\n👤 User: ${user.id}\n`);
  console.log(`Karma: ${user.karma}`);
  console.log(`Created: ${new Date(user.created * 1000).toISOString().split('T')[0]}`);
  if (user.about) console.log(`About: ${user.about.replace(/<[^>]*>/g, '')}`);
  if (user.submitted) console.log(`Submissions: ${user.submitted.length}`);
}

async function search(query, count = 10) {
  const url = `${ALGOLIA_API}/search?query=${encodeURIComponent(query)}&tags=story&hitsPerPage=${count}`;
  const result = await fetch(url);
  
  console.log(`\n🔍 Search: "${query}" (${result.nbHits} total hits)\n`);
  (result.hits || []).forEach((hit, i) => {
    const url = hit.url ? ` → ${hit.url}` : '';
    console.log(`${i + 1}. ${hit.title}`);
    console.log(`   ⬆${hit.points || 0} | 💬${hit.num_comments || 0} | @${hit.author} | ${hit.created_at?.split('T')[0] || ''}${url}`);
    console.log();
  });
}

async function main() {
  const [,, cmd, ...args] = process.argv;
  
  if (!cmd || cmd === '--help' || cmd === '-h') {
    console.log(`
Hacker News CLI Tool 🔥

Usage:
  node tools/hn.js top [N]        Top stories (default 10)
  node tools/hn.js new [N]        Newest stories
  node tools/hn.js best [N]       Best stories
  node tools/hn.js ask [N]        Ask HN
  node tools/hn.js show [N]       Show HN
  node tools/hn.js jobs [N]       Job postings
  node tools/hn.js item <id>      Get item details
  node tools/hn.js user <id>      Get user info
  node tools/hn.js search <query> Search stories (Algolia)
`);
    return;
  }
  
  try {
    switch (cmd) {
      case 'top': case 'new': case 'best': case 'ask': case 'show': case 'jobs':
        await getStories(cmd, parseInt(args[0]) || 10);
        break;
      case 'item':
        if (!args[0]) return console.log('Usage: node tools/hn.js item <id>');
        await getItem(args[0]);
        break;
      case 'user':
        if (!args[0]) return console.log('Usage: node tools/hn.js user <id>');
        await getUser(args[0]);
        break;
      case 'search':
        if (!args[0]) return console.log('Usage: node tools/hn.js search <query>');
        await search(args.join(' '), 10);
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
