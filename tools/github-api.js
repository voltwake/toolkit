#!/usr/bin/env node
/**
 * GitHub API CLI Tool
 * 使用 voltwake 账号与 GitHub API 交互
 * 凭据从 ~/.config/github/credentials.json 读取
 * 
 * Usage:
 *   node tools/github-api.js me                          - 查看当前用户信息
 *   node tools/github-api.js repos [user]                - 列出仓库
 *   node tools/github-api.js repo <owner/name>           - 查看仓库详情
 *   node tools/github-api.js create <name> [desc]        - 创建新仓库
 *   node tools/github-api.js search <query>              - 搜索仓库
 *   node tools/github-api.js trending [language] [since] - 热门仓库 (daily/weekly/monthly)
 *   node tools/github-api.js stars <owner/name>          - 给仓库加星
 *   node tools/github-api.js readme <owner/name>         - 读取仓库 README
 *   node tools/github-api.js issues <owner/name> [N]     - 查看 issues
 *   node tools/github-api.js releases <owner/name> [N]   - 查看 releases
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

const CRED_FILE = path.join(process.env.HOME || process.env.USERPROFILE, '.config', 'github', 'credentials.json');
const API = 'https://api.github.com';

function loadToken() {
  try {
    const creds = JSON.parse(fs.readFileSync(CRED_FILE, 'utf8'));
    return creds.token || creds.pat || null;
  } catch {
    return null;
  }
}

function request(method, urlPath, body = null) {
  return new Promise((resolve, reject) => {
    const token = loadToken();
    const url = urlPath.startsWith('http') ? new URL(urlPath) : new URL(API + urlPath);
    
    const headers = {
      'User-Agent': 'voltwake-github-cli/1.0',
      'Accept': 'application/vnd.github+json',
    };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    if (body) headers['Content-Type'] = 'application/json';
    
    const opts = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method,
      headers,
    };
    
    const req = https.request(opts, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (res.statusCode >= 400) {
            reject(new Error(`HTTP ${res.statusCode}: ${json.message || data}`));
          } else {
            resolve(json);
          }
        } catch {
          resolve(data);
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function formatNum(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
  return String(n);
}

async function me() {
  const user = await request('GET', '/user');
  console.log(`\n👤 ${user.login} (${user.name || 'No name'})\n`);
  console.log(`Bio: ${user.bio || 'None'}`);
  console.log(`Repos: ${user.public_repos} public, ${user.total_private_repos || 0} private`);
  console.log(`Followers: ${user.followers} | Following: ${user.following}`);
  console.log(`Created: ${user.created_at?.split('T')[0]}`);
  console.log(`URL: ${user.html_url}`);
}

async function repos(user) {
  const endpoint = user ? `/users/${user}/repos?sort=updated&per_page=20` : '/user/repos?sort=updated&per_page=20';
  const items = await request('GET', endpoint);
  
  console.log(`\n📦 Repositories${user ? ` (${user})` : ''}\n`);
  items.forEach(r => {
    const lang = r.language ? `[${r.language}]` : '';
    const stars = r.stargazers_count ? `⭐${formatNum(r.stargazers_count)}` : '';
    const priv = r.private ? '🔒' : '';
    console.log(`  ${priv}${r.full_name} ${lang} ${stars}`);
    if (r.description) console.log(`    ${r.description.substring(0, 80)}`);
  });
}

async function repoInfo(fullName) {
  const r = await request('GET', `/repos/${fullName}`);
  console.log(`\n📦 ${r.full_name}\n`);
  console.log(`Description: ${r.description || 'None'}`);
  console.log(`Language: ${r.language || 'N/A'}`);
  console.log(`Stars: ${formatNum(r.stargazers_count)} | Forks: ${formatNum(r.forks_count)} | Watchers: ${r.watchers_count}`);
  console.log(`Issues: ${r.open_issues_count}`);
  console.log(`Created: ${r.created_at?.split('T')[0]} | Updated: ${r.updated_at?.split('T')[0]}`);
  console.log(`License: ${r.license?.name || 'None'}`);
  console.log(`URL: ${r.html_url}`);
  if (r.topics?.length) console.log(`Topics: ${r.topics.join(', ')}`);
}

async function createRepo(name, description) {
  const r = await request('POST', '/user/repos', {
    name,
    description: description || '',
    auto_init: true,
    private: false,
  });
  console.log(`\n✅ Created: ${r.full_name}`);
  console.log(`URL: ${r.html_url}`);
}

async function searchRepos(query) {
  const r = await request('GET', `/search/repositories?q=${encodeURIComponent(query)}&sort=stars&per_page=15`);
  console.log(`\n🔍 Search: "${query}" (${formatNum(r.total_count)} results)\n`);
  (r.items || []).forEach((repo, i) => {
    const lang = repo.language ? `[${repo.language}]` : '';
    console.log(`${i + 1}. ${repo.full_name} ⭐${formatNum(repo.stargazers_count)} ${lang}`);
    if (repo.description) console.log(`   ${repo.description.substring(0, 100)}`);
    console.log(`   ${repo.html_url}`);
    console.log();
  });
}

async function star(fullName) {
  await request('PUT', `/user/starred/${fullName}`);
  console.log(`⭐ Starred ${fullName}`);
}

async function readme(fullName) {
  const r = await request('GET', `/repos/${fullName}/readme`);
  const content = Buffer.from(r.content, 'base64').toString('utf8');
  console.log(`\n📄 README — ${fullName}\n`);
  console.log(content.substring(0, 3000));
  if (content.length > 3000) console.log('\n... (truncated)');
}

async function issues(fullName, count = 10) {
  const items = await request('GET', `/repos/${fullName}/issues?state=open&per_page=${count}`);
  console.log(`\n🐛 Issues — ${fullName}\n`);
  items.forEach(issue => {
    const labels = issue.labels?.map(l => l.name).join(', ');
    console.log(`  #${issue.number} ${issue.title}`);
    console.log(`    @${issue.user.login} | 💬${issue.comments} | ${issue.created_at?.split('T')[0]}${labels ? ' | ' + labels : ''}`);
  });
}

async function releases(fullName, count = 5) {
  const items = await request('GET', `/repos/${fullName}/releases?per_page=${count}`);
  console.log(`\n🚀 Releases — ${fullName}\n`);
  items.forEach(r => {
    console.log(`  ${r.tag_name} — ${r.name || '(no title)'}`);
    console.log(`    ${r.published_at?.split('T')[0]} | Downloads: ${r.assets?.reduce((s, a) => s + a.download_count, 0) || 0}`);
    if (r.body) console.log(`    ${r.body.substring(0, 150).replace(/\n/g, ' ')}...`);
    console.log();
  });
}

async function main() {
  const [,, cmd, ...args] = process.argv;
  
  if (!cmd || cmd === '--help' || cmd === '-h') {
    console.log(`
GitHub API CLI Tool 🐙

Usage:
  node tools/github-api.js me                          Current user info
  node tools/github-api.js repos [user]                List repositories  
  node tools/github-api.js repo <owner/name>           Repository details
  node tools/github-api.js create <name> [description] Create new repo
  node tools/github-api.js search <query>              Search repositories
  node tools/github-api.js stars <owner/name>          Star a repository
  node tools/github-api.js readme <owner/name>         Read README
  node tools/github-api.js issues <owner/name> [N]     View issues
  node tools/github-api.js releases <owner/name> [N]   View releases

Credentials: ${CRED_FILE}
Note: Without a token, only public API access (60 req/hour). With PAT: 5000 req/hour.
`);
    return;
  }
  
  try {
    switch (cmd) {
      case 'me': await me(); break;
      case 'repos': await repos(args[0]); break;
      case 'repo': await repoInfo(args[0]); break;
      case 'create': await createRepo(args[0], args.slice(1).join(' ')); break;
      case 'search': await searchRepos(args.join(' ')); break;
      case 'star': case 'stars': await star(args[0]); break;
      case 'readme': await readme(args[0]); break;
      case 'issues': await issues(args[0], parseInt(args[1]) || 10); break;
      case 'releases': await releases(args[0], parseInt(args[1]) || 5); break;
      default: console.log(`Unknown command: ${cmd}. Run with --help for usage.`);
    }
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
}

main();
