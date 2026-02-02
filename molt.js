#!/usr/bin/env node
// Moltbook API helper
// Usage: node molt.js <method> <path> [json_body]
const https = require('https');
const fs = require('fs');

const CREDS_PATH = require('path').join(require('os').homedir(), '.config', 'moltbook', 'credentials.json');
const creds = JSON.parse(fs.readFileSync(CREDS_PATH, 'utf8'));
const API_KEY = creds.api_key;
const BASE = '/api/v1';

const [,, method = 'GET', path = '/agents/me', bodyArg] = process.argv;

const fullPath = path.startsWith('/api/') ? path : BASE + path;
const url = new URL('https://www.moltbook.com' + fullPath);

function makeRequest(reqUrl, reqMethod, body, redirectCount = 0) {
  if (redirectCount > 5) { console.error('Too many redirects'); process.exit(1); }
  
  const options = {
    hostname: reqUrl.hostname,
    port: 443,
    path: reqUrl.pathname + reqUrl.search,
    method: reqMethod.toUpperCase(),
    headers: {
      'Authorization': `Bearer ${API_KEY}`,
      'X-API-Key': API_KEY,
      'Content-Type': 'application/json',
      'User-Agent': 'voltwake/1.0'
    }
  };

  const req = https.request(options, (res) => {
    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
      const newUrl = new URL(res.headers.location, reqUrl);
      makeRequest(newUrl, reqMethod, body, redirectCount + 1);
      return;
    }
    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', () => {
      try {
        const parsed = JSON.parse(data);
        if (process.argv.includes('--compact')) {
          console.log(JSON.stringify(parsed));
        } else {
          console.log(JSON.stringify(parsed, null, 2));
        }
      } catch {
        console.log(data);
      }
    });
  });

  req.on('error', e => { console.error('Error:', e.message); process.exit(1); });
  if (body) req.write(body);
  req.end();
}

let body = null;
if (bodyArg && bodyArg !== '--compact') {
  body = bodyArg.startsWith('@') ? fs.readFileSync(bodyArg.slice(1), 'utf8') : bodyArg;
}
makeRequest(url, method, body);
