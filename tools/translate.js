#!/usr/bin/env node
/**
 * Translation CLI Tool
 * API: MyMemory Translation API (免费，无需 key)
 * 限制: 5000字符/请求，匿名 1000次/天
 * 
 * Usage:
 *   node tools/translate.js <text>                    - Auto-detect → English/Chinese
 *   node tools/translate.js <text> --to <lang>        - Translate to specific language
 *   node tools/translate.js <text> --from <lang> --to <lang>
 * 
 * Languages: en, zh, ja, ko, fr, de, es, pt, ru, ar, etc.
 * Auto-detect: Chinese input → English, everything else → Chinese
 */

const https = require('https');

function fetch(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error('Invalid response')); }
      });
    }).on('error', reject);
  });
}

function detectLang(text) {
  // Simple heuristic: if contains CJK chars, likely Chinese
  const cjk = /[\u4e00-\u9fff\u3400-\u4dbf]/;
  if (cjk.test(text)) return 'zh-CN';
  
  const jp = /[\u3040-\u309f\u30a0-\u30ff]/;
  if (jp.test(text)) return 'ja';
  
  const kr = /[\uac00-\ud7af\u1100-\u11ff]/;
  if (kr.test(text)) return 'ko';
  
  return 'en';
}

async function translate(text, from, to) {
  const langPair = `${from}|${to}`;
  const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=${encodeURIComponent(langPair)}`;
  
  const result = await fetch(url);
  
  if (result.responseStatus !== 200) {
    throw new Error(`Translation failed: ${result.responseDetails || 'Unknown error'}`);
  }
  
  const main = result.responseData?.translatedText || '';
  const matches = (result.matches || [])
    .filter(m => m.translation !== main && m.quality && parseInt(m.quality) > 50)
    .slice(0, 3);
  
  console.log(`\n🌐 Translation (${from} → ${to})\n`);
  console.log(`Original:    ${text}`);
  console.log(`Translated:  ${main}`);
  
  if (matches.length > 0) {
    console.log(`\nAlternatives:`);
    matches.forEach((m, i) => {
      const q = m.quality ? ` (${m.quality}%)` : '';
      console.log(`  ${i + 1}. ${m.translation}${q}`);
    });
  }
  
  return main;
}

async function main() {
  const args = process.argv.slice(2);
  
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    console.log(`
Translation CLI Tool 🌐

Usage:
  node tools/translate.js "Hello world"                    Auto-detect → en/zh
  node tools/translate.js "你好世界" --to en               Chinese → English
  node tools/translate.js "Hello" --from en --to ja        English → Japanese
  node tools/translate.js "Bonjour" --to zh                French → Chinese

Languages: en, zh-CN, ja, ko, fr, de, es, pt, ru, ar, it, nl, etc.
API: MyMemory (free, no key needed, 1000 req/day)
`);
    return;
  }
  
  let from = null;
  let to = null;
  const textParts = [];
  
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--from' && args[i + 1]) { from = args[++i]; }
    else if (args[i] === '--to' && args[i + 1]) { to = args[++i]; }
    else { textParts.push(args[i]); }
  }
  
  const text = textParts.join(' ');
  if (!text) return console.log('Error: No text provided');
  
  if (!from) from = detectLang(text);
  if (!to) to = from === 'en' ? 'zh-CN' : 'en';
  
  try {
    await translate(text, from, to);
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
}

main();
