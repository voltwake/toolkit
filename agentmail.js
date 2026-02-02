#!/usr/bin/env node
/**
 * agentmail.js - AgentMail API 工具
 * 
 * Usage:
 *   node tools/agentmail.js inbox                      # 查看收件箱信息
 *   node tools/agentmail.js list [limit]               # 列出邮件
 *   node tools/agentmail.js read <messageId>           # 读取邮件
 *   node tools/agentmail.js send <to> <subject> <body> # 发送邮件
 *   node tools/agentmail.js test                       # 发送测试邮件给自己
 * 
 * 凭据从 ~/.config/agentmail/credentials.json 读取
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

// 读取凭据
function loadCredentials() {
  const credPath = path.join(process.env.HOME || process.env.USERPROFILE, '.config', 'agentmail', 'credentials.json');
  try {
    return JSON.parse(fs.readFileSync(credPath, 'utf8'));
  } catch (e) {
    console.error('❌ 无法读取凭据文件:', credPath);
    console.error('请确保 ~/.config/agentmail/credentials.json 存在');
    process.exit(1);
  }
}

function apiRequest(method, apiPath, body = null) {
  const creds = loadCredentials();
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.agentmail.to',
      path: `/v0${apiPath}`,
      method: method,
      headers: {
        'Authorization': `Bearer ${creds.apiKey}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      }
    };
    
    if (body) {
      const data = JSON.stringify(body);
      options.headers['Content-Length'] = Buffer.byteLength(data);
    }
    
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = data ? JSON.parse(data) : {};
          if (res.statusCode >= 400) {
            reject(new Error(`API ${res.statusCode}: ${JSON.stringify(parsed)}`));
          } else {
            resolve(parsed);
          }
        } catch (e) {
          reject(new Error(`JSON parse error: ${data.slice(0, 300)}`));
        }
      });
    });
    
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// 命令实现
async function showInbox() {
  const creds = loadCredentials();
  const inboxId = creds.inboxId || 'voltwake@agentmail.to';
  
  try {
    const info = await apiRequest('GET', `/inboxes/${encodeURIComponent(inboxId)}`);
    console.log('\n📧 AgentMail 收件箱');
    console.log('═'.repeat(45));
    console.log(`  地址: ${info.inbox_id || inboxId}`);
    console.log(`  显示名: ${info.display_name || 'N/A'}`);
    console.log(`  创建时间: ${info.created_at || 'N/A'}`);
    console.log('');
  } catch (e) {
    console.error('❌', e.message);
  }
}

async function listMessages(limit = 10) {
  const creds = loadCredentials();
  const inboxId = creds.inboxId || 'voltwake@agentmail.to';
  
  try {
    const result = await apiRequest('GET', `/inboxes/${encodeURIComponent(inboxId)}/messages?limit=${limit}`);
    const messages = result.messages || result.data || result || [];
    
    console.log('\n📬 收件箱邮件');
    console.log('═'.repeat(60));
    
    if (Array.isArray(messages) && messages.length > 0) {
      for (const msg of messages) {
        const from = msg.from || msg.sender || 'unknown';
        const subject = msg.subject || '(无主题)';
        const date = msg.created_at || msg.date || '';
        const id = msg.message_id || msg.id || '';
        console.log(`\n  📩 ${subject}`);
        console.log(`     From: ${typeof from === 'object' ? from.email || JSON.stringify(from) : from}`);
        console.log(`     Date: ${date}`);
        console.log(`     ID: ${id}`);
      }
    } else {
      console.log('  (空收件箱)');
    }
    console.log('');
  } catch (e) {
    console.error('❌', e.message);
  }
}

async function readMessage(messageId) {
  const creds = loadCredentials();
  const inboxId = creds.inboxId || 'voltwake@agentmail.to';
  
  try {
    const msg = await apiRequest('GET', `/inboxes/${encodeURIComponent(inboxId)}/messages/${messageId}`);
    console.log('\n📖 邮件详情');
    console.log('═'.repeat(60));
    console.log(`  Subject: ${msg.subject || '(无主题)'}`);
    console.log(`  From: ${JSON.stringify(msg.from || msg.sender)}`);
    console.log(`  To: ${JSON.stringify(msg.to || msg.recipients)}`);
    console.log(`  Date: ${msg.created_at || msg.date || ''}`);
    console.log('─'.repeat(60));
    console.log(msg.text || msg.body || msg.html || '(无内容)');
    console.log('');
  } catch (e) {
    console.error('❌', e.message);
  }
}

async function sendMessage(to, subject, body) {
  const creds = loadCredentials();
  const inboxId = creds.inboxId || 'voltwake@agentmail.to';
  
  try {
    const result = await apiRequest('POST', `/inboxes/${encodeURIComponent(inboxId)}/messages/send`, {
      to,
      subject,
      text: body,
    });
    console.log('\n✅ 邮件已发送!');
    console.log(`  To: ${to}`);
    console.log(`  Subject: ${subject}`);
    if (result.message_id) console.log(`  Message ID: ${result.message_id}`);
    console.log('');
  } catch (e) {
    console.error('❌ 发送失败:', e.message);
  }
}

async function sendTest() {
  await sendMessage(
    'voltwake@agentmail.to',
    'Hello from voltwake!',
    '这是小v的第一封测试邮件。AgentMail API 测试成功！⚡'
  );
}

// 主入口
async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  
  if (!cmd) {
    console.log('Usage:');
    console.log('  node tools/agentmail.js inbox                      # 收件箱信息');
    console.log('  node tools/agentmail.js list [limit]               # 列出邮件');
    console.log('  node tools/agentmail.js read <messageId>           # 读取邮件');
    console.log('  node tools/agentmail.js send <to> <subject> <body> # 发送邮件');
    console.log('  node tools/agentmail.js test                       # 测试邮件');
    process.exit(0);
  }
  
  switch (cmd) {
    case 'inbox': await showInbox(); break;
    case 'list': await listMessages(parseInt(args[0]) || 10); break;
    case 'read': 
      if (!args[0]) { console.error('需要 messageId'); process.exit(1); }
      await readMessage(args[0]); break;
    case 'send':
      if (args.length < 3) { console.error('需要: <to> <subject> <body>'); process.exit(1); }
      await sendMessage(args[0], args[1], args.slice(2).join(' ')); break;
    case 'test': await sendTest(); break;
    default: console.error(`未知命令: ${cmd}`); process.exit(1);
  }
}

main().catch(err => {
  console.error(`❌ Error: ${err.message}`);
  process.exit(1);
});
