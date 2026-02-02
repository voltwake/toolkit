#!/usr/bin/env node
/**
 * Solana Wallet Manager
 * 
 * Usage:
 *   node tools/wallet.js generate       - 生成新钱包
 *   node tools/wallet.js address         - 显示公钥地址
 *   node tools/wallet.js balance         - 查询余额
 */

const { Keypair, Connection, LAMPORTS_PER_SOL, PublicKey } = require('@solana/web3.js');
const bs58 = require('bs58');
const fs = require('fs');
const path = require('path');

const WALLET_DIR = path.join(process.env.HOME || process.env.USERPROFILE, '.config', 'solana');
const WALLET_FILE = path.join(WALLET_DIR, 'voltwake-wallet.json');
const RPC = 'https://api.mainnet-beta.solana.com';

function ensureDir() {
  if (!fs.existsSync(WALLET_DIR)) fs.mkdirSync(WALLET_DIR, { recursive: true });
}

function walletExists() {
  return fs.existsSync(WALLET_FILE);
}

function loadWallet() {
  if (!walletExists()) {
    console.log('❌ 钱包不存在，先运行: node tools/wallet.js generate');
    process.exit(1);
  }
  const data = JSON.parse(fs.readFileSync(WALLET_FILE, 'utf-8'));
  return Keypair.fromSecretKey(Uint8Array.from(data.secretKey));
}

function cmdGenerate() {
  if (walletExists()) {
    console.log('⚠️ 钱包已存在！不会覆盖。');
    console.log('地址:', JSON.parse(fs.readFileSync(WALLET_FILE, 'utf-8')).publicKey);
    return;
  }

  ensureDir();
  const keypair = Keypair.generate();
  const walletData = {
    publicKey: keypair.publicKey.toBase58(),
    secretKey: Array.from(keypair.secretKey),
    createdAt: new Date().toISOString(),
    note: '小v (voltwake) 的 Solana 钱包 — 私钥绝不外泄',
  };

  fs.writeFileSync(WALLET_FILE, JSON.stringify(walletData, null, 2));
  
  console.log('✅ Solana 钱包已生成！');
  console.log(`📍 地址: ${keypair.publicKey.toBase58()}`);
  console.log(`📁 存储: ${WALLET_FILE}`);
  console.log('\n🔒 安全提醒:');
  console.log('  - 私钥仅存储在本地，绝不上传/分享');
  console.log('  - 公钥地址可以公开（用于接收）');
}

function cmdAddress() {
  const keypair = loadWallet();
  console.log(keypair.publicKey.toBase58());
}

async function cmdBalance() {
  const keypair = loadWallet();
  const conn = new Connection(RPC, 'confirmed');
  
  try {
    const balance = await conn.getBalance(keypair.publicKey);
    const sol = balance / LAMPORTS_PER_SOL;
    console.log(`💰 ${keypair.publicKey.toBase58()}`);
    console.log(`   余额: ${sol.toFixed(6)} SOL`);
    
    // 获取 SOL 价格
    const https = require('https');
    const priceData = await new Promise((resolve, reject) => {
      https.get('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd,cny', res => {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { resolve(null); } });
      }).on('error', () => resolve(null));
    });
    
    if (priceData?.solana) {
      const usd = (sol * priceData.solana.usd).toFixed(2);
      const cny = (sol * priceData.solana.cny).toFixed(2);
      console.log(`   ≈ $${usd} / ¥${cny}`);
    }
  } catch (e) {
    console.error('查询失败:', e.message);
  }
}

async function main() {
  const [,, cmd] = process.argv;
  
  switch (cmd) {
    case 'generate': cmdGenerate(); break;
    case 'address': cmdAddress(); break;
    case 'balance': await cmdBalance(); break;
    default:
      console.log(`
🔑 Solana Wallet Manager

Usage:
  node tools/wallet.js generate    生成新钱包
  node tools/wallet.js address     显示地址
  node tools/wallet.js balance     查询余额
`);
  }
}

main().catch(e => { console.error('Error:', e.message); process.exit(1); });
