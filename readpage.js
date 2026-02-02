#!/usr/bin/env node
/**
 * Web Page Reader CLI Tool v2
 * 三层提取策略：Jina Reader API → Cheerio → Regex fallback
 * 
 * Usage:
 *   node tools/readpage.js <url>              - 读取网页（默认用 Jina Reader）
 *   node tools/readpage.js <url> --local      - 强制本地提取（不用 Jina）
 *   node tools/readpage.js <url> --raw        - 输出原始 HTML
 *   node tools/readpage.js <url> --links      - 只提取链接
 *   node tools/readpage.js <url> --max <N>    - 限制输出字符数 (default 5000)
 *   node tools/readpage.js <url> --json       - JSON 格式输出
 * 
 * Jina Reader API: https://r.jina.ai/<url> (免费，无需 key)
 */

const https = require('https');
const http = require('http');
let cheerio, Readability, JSDOM;
try { cheerio = require('cheerio'); } catch { cheerio = null; }
try { Readability = require('@mozilla/readability').Readability; JSDOM = require('jsdom').JSDOM; } catch { Readability = null; }

function fetch(url, redirects = 5, headers = {}) {
  return new Promise((resolve, reject) => {
    if (redirects <= 0) return reject(new Error('Too many redirects'));
    const mod = url.startsWith('https') ? https : http;
    const defaultHeaders = {
      'User-Agent': 'Mozilla/5.0 (compatible; voltwake-reader/2.0)',
      'Accept': 'text/html,application/xhtml+xml,text/plain,*/*',
      'Accept-Language': 'en-US,en;q=0.9,zh-CN;q=0.8',
      ...headers,
    };
    mod.get(url, { headers: defaultHeaders }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        let nextUrl = res.headers.location;
        if (nextUrl.startsWith('/')) {
          const u = new URL(url);
          nextUrl = `${u.protocol}//${u.host}${nextUrl}`;
        }
        return resolve(fetch(nextUrl, redirects - 1, headers));
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        resolve({ text: buf.toString('utf8'), status: res.statusCode, contentType: res.headers['content-type'] });
      });
    }).on('error', reject);
  });
}

// ==================== Strategy 1: Jina Reader API ====================
async function jinaReader(url, maxChars) {
  const jinaUrl = `https://r.jina.ai/${url}`;
  const { text, status } = await fetch(jinaUrl, 3, {
    'Accept': 'text/plain',
    'User-Agent': 'voltwake-reader/2.0',
  });
  
  if (status >= 400) throw new Error(`Jina Reader returned HTTP ${status}`);
  
  // Parse Jina's output format
  const titleMatch = text.match(/^Title:\s*(.+)$/m);
  const title = titleMatch ? titleMatch[1].trim() : '';
  
  const publishedMatch = text.match(/^Published Time:\s*(.+)$/m);
  const published = publishedMatch ? publishedMatch[1].trim() : '';
  
  // Extract markdown content (after "Markdown Content:" header)
  const mdStart = text.indexOf('Markdown Content:');
  let content = mdStart >= 0 ? text.substring(mdStart + 17).trim() : text;
  
  // Clean up: remove excessive image markdown, nav items
  content = content
    .replace(/!\[Image \d+[^\]]*\]\([^)]+\)\n*/g, '') // Remove image references
    .replace(/\[!\[Image[^\]]*\]\([^)]*\)\s*[^\]]*\]\([^)]*\)/g, '') // Remove linked images
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  
  return { title, published, content: content.substring(0, maxChars), method: 'jina' };
}

// ==================== Strategy 2: Mozilla Readability ====================
function extractReadability(html, url) {
  const doc = new JSDOM(html, { url });
  const reader = new Readability(doc.window.document);
  const article = reader.parse();
  
  if (!article || !article.textContent) return null;
  
  // Convert the HTML content to clean markdown-ish text
  let content = article.content || '';
  content = content
    .replace(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/gi, (_, t) => `\n\n## ${t.replace(/<[^>]*>/g, '').trim()}\n`)
    .replace(/<p[^>]*>/gi, '\n\n').replace(/<\/p>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n  • ').replace(/<\/li>/gi, '')
    .replace(/<blockquote[^>]*>/gi, '\n\n> ').replace(/<\/blockquote>/gi, '')
    .replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_, c) => `\n\n\`\`\`\n${c.replace(/<[^>]*>/g, '')}\n\`\`\`\n`)
    .replace(/<(?:b|strong)[^>]*>([\s\S]*?)<\/(?:b|strong)>/gi, '**$1**')
    .replace(/<(?:i|em)[^>]*>([\s\S]*?)<\/(?:i|em)>/gi, '*$1*')
    .replace(/<a[^>]*href=["']([^"']*?)["'][^>]*>([\s\S]*?)<\/a>/gi, '$2')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  
  return {
    title: article.title || '',
    description: article.excerpt || '',
    published: article.publishedTime || '',
    content,
    method: 'readability',
    byline: article.byline || '',
    siteName: article.siteName || '',
    length: article.length || 0,
  };
}

// ==================== Strategy 3: Cheerio ====================
function extractCheerio(html) {
  const $ = cheerio.load(html);
  
  $('script, style, nav, footer, header, aside, iframe, noscript, [role="navigation"], [role="banner"], .sidebar, .ad, .advertisement, .social-share, .related-posts, .comments').remove();
  
  const title = $('title').first().text().trim() || $('h1').first().text().trim();
  const description = $('meta[name="description"]').attr('content') || $('meta[property="og:description"]').attr('content') || '';
  const published = $('meta[property="article:published_time"]').attr('content') || $('time').first().attr('datetime') || '';
  
  let $content = $('article').first();
  if (!$content.length) $content = $('main').first();
  if (!$content.length) $content = $('[role="main"]').first();
  if (!$content.length) $content = $('.post-content, .article-content, .entry-content, .content, .post-body').first();
  if (!$content.length) $content = $('body');
  
  let text = '';
  $content.find('h1,h2,h3,h4,h5,h6,p,li,blockquote,pre,td,figcaption').each((_, el) => {
    const $el = $(el);
    const tag = el.tagName?.toLowerCase();
    const t = $el.text().trim();
    if (!t || t.length < 3) return;
    
    if (tag?.startsWith('h')) {
      const level = '#'.repeat(Math.min(parseInt(tag[1]) || 2, 4));
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
  
  return { title, description, published, content: text.replace(/\n{3,}/g, '\n\n').trim(), method: 'cheerio' };
}

// ==================== Strategy 3: Regex fallback ====================
function extractRegex(html) {
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
                       clean.match(/<main[^>]*>([\s\S]*?)<\/main>/i);
  const contentHtml = articleMatch ? articleMatch[1] : clean;
  
  let text = contentHtml
    .replace(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/gi, (_, t) => `\n\n## ${t.replace(/<[^>]*>/g, '').trim()}\n`)
    .replace(/<p[^>]*>/gi, '\n\n').replace(/<\/p>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n  • ').replace(/<\/li>/gi, '')
    .replace(/<(?:b|strong)[^>]*>([\s\S]*?)<\/(?:b|strong)>/gi, '**$1**')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  
  return { title, description, published: '', content: text, method: 'regex' };
}

// ==================== Links extractor ====================
function extractLinks(html, baseUrl) {
  if (cheerio) {
    const $ = cheerio.load(html);
    const links = [];
    $('a[href]').each((_, el) => {
      const href = $(el).attr('href');
      const text = $(el).text().trim();
      if (!text || text.length < 2 || href.startsWith('#') || href.startsWith('javascript:')) return;
      let url = href;
      if (url.startsWith('/')) { try { url = new URL(url, baseUrl).href; } catch {} }
      if (url.startsWith('http')) links.push({ text: text.substring(0, 80), url });
    });
    const seen = new Set();
    return links.filter(l => { if (seen.has(l.url)) return false; seen.add(l.url); return true; });
  }
  // Regex fallback
  const links = [];
  const re = /<a[^>]*href=["']([^"'#]+?)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    let url = m[1]; const text = m[2].replace(/<[^>]*>/g, '').trim();
    if (!text || text.length < 2) continue;
    if (url.startsWith('/')) { try { url = new URL(url, baseUrl).href; } catch {} }
    if (url.startsWith('http')) links.push({ text: text.substring(0, 80), url });
  }
  const seen = new Set();
  return links.filter(l => { if (seen.has(l.url)) return false; seen.add(l.url); return true; });
}

// ==================== Main ====================
async function main() {
  const args = process.argv.slice(2);
  
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    console.log(`
Web Page Reader v2 📖

Usage:
  node tools/readpage.js <url>              Read page (Jina Reader → Cheerio → Regex)
  node tools/readpage.js <url> --local      Force local extraction (skip Jina)
  node tools/readpage.js <url> --raw        Output raw HTML
  node tools/readpage.js <url> --links      Extract links only
  node tools/readpage.js <url> --max <N>    Max chars (default 5000)
  node tools/readpage.js <url> --json       JSON output

Extraction pipeline: Jina Reader API → Cheerio → Regex fallback
`);
    return;
  }
  
  const url = args.find(a => a.startsWith('http'));
  if (!url) return console.log('Error: No URL provided');
  
  const raw = args.includes('--raw');
  const linksOnly = args.includes('--links');
  const local = args.includes('--local');
  const json = args.includes('--json');
  const maxIdx = args.indexOf('--max');
  const maxChars = maxIdx >= 0 ? parseInt(args[maxIdx + 1]) || 5000 : 5000;
  
  try {
    if (raw) {
      const { text } = await fetch(url);
      console.log(text.substring(0, maxChars));
      return;
    }
    
    if (linksOnly) {
      const { text: html } = await fetch(url);
      const links = extractLinks(html, url);
      if (json) {
        console.log(JSON.stringify(links.slice(0, 50), null, 2));
      } else {
        console.log(`\n🔗 Links (${links.length} found)\n`);
        links.slice(0, 50).forEach((l, i) => console.log(`${i + 1}. ${l.text}\n   ${l.url}`));
      }
      return;
    }
    
    let result;
    
    // Strategy 1: Jina Reader (unless --local)
    if (!local) {
      try {
        result = await jinaReader(url, maxChars);
      } catch (e) {
        // Jina failed, fall through to local
      }
    }
    
    // Strategy 2/3/4: Local extraction
    if (!result) {
      const { text: html, status } = await fetch(url);
      if (status >= 400) return console.log(`Error: HTTP ${status}`);
      
      // Try Readability first (best quality), then Cheerio, then Regex
      if (Readability) {
        result = extractReadability(html, url);
      }
      if (!result && cheerio) {
        result = extractCheerio(html);
      }
      if (!result) {
        result = extractRegex(html);
      }
      result.content = result.content.substring(0, maxChars);
    }
    
    if (json) {
      console.log(JSON.stringify({
        title: result.title,
        published: result.published || undefined,
        method: result.method,
        url,
        content: result.content,
      }, null, 2));
      return;
    }
    
    console.log(`\n📖 ${result.title || 'Untitled'}`);
    if (result.published) console.log(`📅 ${result.published}`);
    console.log(`🔧 Method: ${result.method}`);
    console.log(`URL: ${url}\n`);
    console.log('---\n');
    console.log(result.content);
    if (result.content.length >= maxChars) {
      console.log(`\n... (truncated at ${maxChars} chars. Use --max to increase)`);
    }
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
}

main();
