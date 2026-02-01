#!/usr/bin/env node
/**
 * Web Page Reader / Summarizer CLI Tool
 * 抓取网页并提取核心内容，输出干净文本
 * 纯 Node.js，无依赖
 * 
 * Usage:
 *   node tools/readpage.js <url>              - 读取并提取网页内容
 *   node tools/readpage.js <url> --raw        - 输出原始 HTML
 *   node tools/readpage.js <url> --links      - 只提取链接
 *   node tools/readpage.js <url> --max <N>    - 限制输出字符数 (default 5000)
 */

const https = require('https');
const http = require('http');
let cheerio;
try { cheerio = require('cheerio'); } catch { cheerio = null; }

function fetch(url, redirects = 5) {
  return new Promise((resolve, reject) => {
    if (redirects <= 0) return reject(new Error('Too many redirects'));
    const mod = url.startsWith('https') ? https : http;
    mod.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; voltwake-reader/1.0)',
        'Accept': 'text/html,application/xhtml+xml,*/*',
        'Accept-Language': 'en-US,en;q=0.9,zh-CN;q=0.8',
      }
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        let nextUrl = res.headers.location;
        if (nextUrl.startsWith('/')) {
          const u = new URL(url);
          nextUrl = `${u.protocol}//${u.host}${nextUrl}`;
        }
        return resolve(fetch(nextUrl, redirects - 1));
      }
      
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        // Try to detect encoding
        const html = buf.toString('utf8');
        resolve({ html, status: res.statusCode, contentType: res.headers['content-type'] });
      });
    }).on('error', reject);
  });
}

function extractContentCheerio(html) {
  const $ = cheerio.load(html);
  
  // Remove noise elements
  $('script, style, nav, footer, header, aside, iframe, noscript, [role="navigation"], [role="banner"], .sidebar, .ad, .advertisement').remove();
  
  const title = $('title').first().text().trim();
  const description = $('meta[name="description"]').attr('content') || $('meta[property="og:description"]').attr('content') || '';
  
  // Try to find main content
  let $content = $('article').first();
  if (!$content.length) $content = $('main').first();
  if (!$content.length) $content = $('[role="main"]').first();
  if (!$content.length) $content = $('.post-content, .article-content, .entry-content, .content').first();
  if (!$content.length) $content = $('body');
  
  // Convert to text with structure
  let text = '';
  $content.find('h1,h2,h3,h4,h5,h6,p,li,blockquote,pre,td').each((_, el) => {
    const $el = $(el);
    const tag = el.tagName?.toLowerCase();
    const t = $el.text().trim();
    if (!t) return;
    
    if (tag?.startsWith('h')) {
      const level = '#'.repeat(parseInt(tag[1]) || 2);
      text += `\n\n${level} ${t}\n`;
    } else if (tag === 'li') {
      text += `\n  • ${t}`;
    } else if (tag === 'blockquote') {
      text += `\n\n> ${t}`;
    } else if (tag === 'pre') {
      text += `\n\n\`\`\`\n${t}\n\`\`\`\n`;
    } else {
      text += `\n\n${t}`;
    }
  });
  
  return { title, description, text: text.replace(/\n{3,}/g, '\n\n').trim() };
}

function extractContentRegex(html) {
  // Fallback: regex-based extraction when cheerio is unavailable
  let clean = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    .replace(/<header[\s\S]*?<\/header>/gi, '')
    .replace(/<aside[\s\S]*?<\/aside>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '');
  
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? titleMatch[1].replace(/<[^>]*>/g, '').trim() : '';
  
  const descMatch = html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']*?)["']/i);
  const description = descMatch ? descMatch[1] : '';
  
  const articleMatch = clean.match(/<article[^>]*>([\s\S]*?)<\/article>/i) ||
                       clean.match(/<main[^>]*>([\s\S]*?)<\/main>/i) ||
                       clean.match(/<div[^>]*class=["'][^"']*(?:content|article|post|entry|story)[^"']*["'][^>]*>([\s\S]*?)<\/div>/i);
  
  const contentHtml = articleMatch ? articleMatch[1] : clean;
  
  let text = contentHtml
    .replace(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/gi, (_, t) => `\n\n## ${t.replace(/<[^>]*>/g, '').trim()}\n`)
    .replace(/<p[^>]*>/gi, '\n\n')
    .replace(/<\/p>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n  • ')
    .replace(/<\/li>/gi, '')
    .replace(/<(?:b|strong)[^>]*>([\s\S]*?)<\/(?:b|strong)>/gi, '**$1**')
    .replace(/<a[^>]*href=["']([^"']*?)["'][^>]*>([\s\S]*?)<\/a>/gi, '$2 ($1)')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ').replace(/&#x27;/g, "'").replace(/&#x2F;/g, '/')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  
  return { title, description, text };
}

function extractContent(html) {
  if (cheerio) return extractContentCheerio(html);
  return extractContentRegex(html);
}

function extractLinks(html, baseUrl) {
  const links = [];
  const re = /<a[^>]*href=["']([^"'#]+?)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    let url = m[1];
    const text = m[2].replace(/<[^>]*>/g, '').trim();
    if (!text || text.length < 2) continue;
    if (url.startsWith('/')) {
      try { url = new URL(url, baseUrl).href; } catch {}
    }
    if (url.startsWith('http')) {
      links.push({ text: text.substring(0, 80), url });
    }
  }
  // Deduplicate by URL
  const seen = new Set();
  return links.filter(l => {
    if (seen.has(l.url)) return false;
    seen.add(l.url);
    return true;
  });
}

async function main() {
  const args = process.argv.slice(2);
  
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    console.log(`
Web Page Reader 📖

Usage:
  node tools/readpage.js <url>              Read and extract page content
  node tools/readpage.js <url> --raw        Output raw HTML
  node tools/readpage.js <url> --links      Extract links only
  node tools/readpage.js <url> --max <N>    Max chars (default 5000)
`);
    return;
  }
  
  const url = args.find(a => a.startsWith('http'));
  if (!url) return console.log('Error: No URL provided');
  
  const raw = args.includes('--raw');
  const linksOnly = args.includes('--links');
  const maxIdx = args.indexOf('--max');
  const maxChars = maxIdx >= 0 ? parseInt(args[maxIdx + 1]) || 5000 : 5000;
  
  try {
    console.log(`Fetching ${url}...`);
    const { html, status } = await fetch(url);
    
    if (status >= 400) {
      console.log(`Error: HTTP ${status}`);
      return;
    }
    
    if (raw) {
      console.log(html.substring(0, maxChars));
      return;
    }
    
    if (linksOnly) {
      const links = extractLinks(html, url);
      console.log(`\n🔗 Links (${links.length} found)\n`);
      links.slice(0, 50).forEach((l, i) => {
        console.log(`${i + 1}. ${l.text}`);
        console.log(`   ${l.url}`);
      });
      return;
    }
    
    const { title, description, text } = extractContent(html);
    
    console.log(`\n📖 ${title || 'Untitled'}\n`);
    if (description) console.log(`> ${description}\n`);
    console.log(`URL: ${url}\n`);
    console.log('---\n');
    
    const output = text.substring(0, maxChars);
    console.log(output);
    if (text.length > maxChars) {
      console.log(`\n... (truncated, ${text.length} total chars. Use --max to increase)`);
    }
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
}

main();
