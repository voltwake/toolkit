#!/usr/bin/env node
/**
 * Solana Agent CLI Tool
 * 基于 solana-agent-kit 的链上操作工具
 * 
 * Usage:
 *   node tools/solana.js balance                    - 查询 SOL 余额
 *   node tools/solana.js address                    - 显示钱包地址
 *   node tools/solana.js price <token>              - 查代币价格（SOL/BTC/ETH）
 *   node tools/solana.js transfer <to> <amount>     - 转账 SOL
 *   node tools/solana.js swap <amount> <from> <to>  - 代币兑换（Jupiter）
 *   node tools/solana.js tokens                     - 查看持有的代币
 *   node tools/solana.js airdrop                    - 检查空投（devnet only）
 */

const fs = require('fs');
const path = require('path');

const WALLET_FILE = path.join(process.env.HOME || process.env.USERPROFILE, '.config', 'solana', 'voltwake-wallet.json');
const RPC_URL = 'https://api.mainnet-beta.solana.com';

// 常见代币 Mint 地址
const TOKEN_MINTS = {
  SOL: 'So11111111111111111111111111111111111111112',
  USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  USDT: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
  JUP: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',
  RAY: '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R',
  BONK: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
  WIF: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm',
  PYTH: 'HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3',
};

function loadWallet() {
  if (!fs.existsSync(WALLET_FILE)) {
    console.log('❌ 钱包不存在。先运行: node tools/wallet.js generate');
    process.exit(1);
  }
  const data = JSON.parse(fs.readFileSync(WALLET_FILE, 'utf-8'));
  return data;
}

async function getAgent() {
  const { SolanaAgentKit, KeypairWallet } = require('solana-agent-kit');
  const { Keypair, Connection, LAMPORTS_PER_SOL, PublicKey } = require('@solana/web3.js');
  
  const walletData = loadWallet();
  const keypair = Keypair.fromSecretKey(Uint8Array.from(walletData.secretKey));
  const wallet = new KeypairWallet(keypair);
  
  const agent = new SolanaAgentKit(wallet, RPC_URL, {});
  return { agent, keypair, publicKey: walletData.publicKey, connection: agent.connection, LAMPORTS_PER_SOL, PublicKey };
}

// ==================== Commands ====================

async function cmdBalance() {
  const { keypair, publicKey, connection, LAMPORTS_PER_SOL } = await getAgent();
  try {
    const lamports = await connection.getBalance(keypair.publicKey);
    const balance = lamports / LAMPORTS_PER_SOL;
    console.log(`💰 ${publicKey}`);
    console.log(`   余额: ${balance} SOL`);
    
    // 获取 USD 价格
    const https = require('https');
    const priceData = await new Promise((resolve) => {
      https.get('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd,cny', res => {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(null); } });
      }).on('error', () => resolve(null));
    });
    
    if (priceData?.solana && balance > 0) {
      console.log(`   ≈ $${(balance * priceData.solana.usd).toFixed(2)} / ¥${(balance * priceData.solana.cny).toFixed(2)}`);
    }
  } catch (e) {
    console.error('查询失败:', e.message);
  }
}

async function cmdAddress() {
  const walletData = loadWallet();
  console.log(walletData.publicKey);
}

async function cmdPrice(token) {
  const name = (token || 'SOL').toUpperCase();
  const ids = { SOL: 'solana', BTC: 'bitcoin', ETH: 'ethereum', JUP: 'jupiter-exchange-solana', BONK: 'bonk', WIF: 'dogwifcoin', USDC: 'usd-coin', RAY: 'raydium', PYTH: 'pyth-network' };
  const id = ids[name];
  if (!id) { console.log(`未知代币: ${name}。支持: ${Object.keys(ids).join(', ')}`); return; }
  
  const https = require('https');
  const data = await new Promise((resolve) => {
    https.get(`https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=usd,cny&include_24hr_change=true`, {
      headers: { 'User-Agent': 'voltwake-solana/1.0' }
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(null); } });
    }).on('error', () => resolve(null));
  });
  
  if (data?.[id]) {
    const p = data[id];
    const arrow = p.usd_24h_change >= 0 ? '↑' : '↓';
    console.log(`📊 ${name}: $${p.usd?.toLocaleString()} (¥${p.cny?.toLocaleString()}) ${arrow}${Math.abs(p.usd_24h_change || 0).toFixed(2)}%`);
  } else {
    console.log(`❌ 无法获取 ${name} 价格`);
  }
}

async function cmdTransfer(to, amount) {
  if (!to || !amount) {
    console.log('Usage: node tools/solana.js transfer <to_address> <sol_amount>');
    return;
  }
  
  const solAmount = parseFloat(amount);
  if (isNaN(solAmount) || solAmount <= 0) {
    console.log('❌ 金额必须大于 0');
    return;
  }
  
  const { keypair, connection, LAMPORTS_PER_SOL, PublicKey } = await getAgent();
  const { Transaction, SystemProgram } = require('@solana/web3.js');
  
  try {
    console.log(`📤 转账 ${solAmount} SOL → ${to}`);
    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: keypair.publicKey,
        toPubkey: new PublicKey(to),
        lamports: Math.round(solAmount * LAMPORTS_PER_SOL),
      })
    );
    const { sendAndConfirmTransaction } = require('@solana/web3.js');
    const sig = await sendAndConfirmTransaction(connection, tx, [keypair]);
    console.log(`✅ 成功！TX: ${sig}`);
    console.log(`🔗 https://solscan.io/tx/${sig}`);
  } catch (e) {
    console.error('❌ 转账失败:', e.message);
  }
}

async function cmdSwap(amount, fromToken, toToken) {
  if (!amount || !fromToken || !toToken) {
    console.log('Usage: node tools/solana.js swap <amount> <from> <to>');
    console.log('Example: node tools/solana.js swap 0.1 SOL USDC');
    console.log(`\nSupported: ${Object.keys(TOKEN_MINTS).join(', ')}`);
    return;
  }
  
  const swapAmount = parseFloat(amount);
  fromToken = fromToken.toUpperCase();
  toToken = toToken.toUpperCase();
  
  const fromMint = TOKEN_MINTS[fromToken];
  const toMint = TOKEN_MINTS[toToken];
  
  if (!fromMint) { console.log(`❌ 未知代币: ${fromToken}`); return; }
  if (!toMint) { console.log(`❌ 未知代币: ${toToken}`); return; }
  
  try {
    // 使用 Jupiter V6 API 直接调用
    const https = require('https');
    const decimals = fromToken === 'SOL' ? 9 : 6;
    const lamports = Math.round(swapAmount * (10 ** decimals));
    
    console.log(`🔄 Swap ${swapAmount} ${fromToken} → ${toToken} (via Jupiter)`);
    
    // Step 1: Get quote
    const quoteUrl = `https://quote-api.jup.ag/v6/quote?inputMint=${fromMint}&outputMint=${toMint}&amount=${lamports}&slippageBps=300`;
    const quote = await new Promise((resolve, reject) => {
      https.get(quoteUrl, res => {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { reject(e); } });
      }).on('error', reject);
    });
    
    if (quote.error) {
      console.log(`❌ 报价失败: ${quote.error}`);
      return;
    }
    
    const outAmount = parseInt(quote.outAmount) / (10 ** (toToken === 'SOL' ? 9 : 6));
    console.log(`   报价: ${swapAmount} ${fromToken} ≈ ${outAmount.toFixed(6)} ${toToken}`);
    console.log(`   (实际执行需要钱包有足够余额)`);
    
    // Step 2: Execute swap (需要余额)
    const { keypair, connection } = await getAgent();
    const walletData = loadWallet();
    
    const swapBody = JSON.stringify({
      quoteResponse: quote,
      userPublicKey: walletData.publicKey,
      wrapAndUnwrapSol: true,
    });
    
    const swapResult = await new Promise((resolve, reject) => {
      const req = https.request('https://quote-api.jup.ag/v6/swap', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      }, res => {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { reject(e); } });
      });
      req.on('error', reject);
      req.write(swapBody);
      req.end();
    });
    
    if (swapResult.error) {
      console.log(`❌ Swap 构建失败: ${swapResult.error}`);
      return;
    }
    
    // Deserialize and send
    const { VersionedTransaction } = require('@solana/web3.js');
    const txBuf = Buffer.from(swapResult.swapTransaction, 'base64');
    const transaction = VersionedTransaction.deserialize(txBuf);
    transaction.sign([keypair]);
    
    const sig = await connection.sendRawTransaction(transaction.serialize());
    await connection.confirmTransaction(sig, 'confirmed');
    
    console.log(`✅ Swap 成功！`);
    console.log(`🔗 https://solscan.io/tx/${sig}`);
  } catch (e) {
    console.error('❌ Swap 失败:', e.message);
  }
}

async function cmdTokens() {
  const { Connection, PublicKey } = require('@solana/web3.js');
  const walletData = loadWallet();
  const conn = new Connection(RPC_URL, 'confirmed');
  
  try {
    const pubkey = new PublicKey(walletData.publicKey);
    
    // SOL balance
    const solBalance = await conn.getBalance(pubkey);
    console.log(`\n💰 代币持仓 — ${walletData.publicKey}\n`);
    console.log(`  SOL: ${(solBalance / 1e9).toFixed(6)}`);
    
    // SPL tokens
    const tokenAccounts = await conn.getParsedTokenAccountsByOwner(pubkey, {
      programId: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),
    });
    
    if (tokenAccounts.value.length === 0) {
      console.log('  (无其他代币)');
    } else {
      for (const account of tokenAccounts.value) {
        const info = account.account.data.parsed.info;
        const amount = info.tokenAmount.uiAmount;
        if (amount > 0) {
          const mint = info.mint;
          const symbol = Object.entries(TOKEN_MINTS).find(([_, v]) => v === mint)?.[0] || mint.substring(0, 8) + '...';
          console.log(`  ${symbol}: ${amount}`);
        }
      }
    }
    console.log();
  } catch (e) {
    console.error('查询失败:', e.message);
  }
}

// ==================== Main ====================

async function main() {
  const [,, cmd, ...args] = process.argv;
  
  if (!cmd || cmd === '--help' || cmd === '-h') {
    console.log(`
🔗 Solana Agent Tool (powered by solana-agent-kit)

Usage:
  node tools/solana.js balance                     查询 SOL 余额
  node tools/solana.js address                     显示钱包地址
  node tools/solana.js price <token>               查代币价格
  node tools/solana.js transfer <to> <amount>      转账 SOL
  node tools/solana.js swap <amount> <from> <to>   代币兑换 (Jupiter)
  node tools/solana.js tokens                      查看持有代币

Supported tokens: ${Object.keys(TOKEN_MINTS).join(', ')}
Wallet: ${WALLET_FILE}
`);
    return;
  }
  
  switch (cmd) {
    case 'balance': await cmdBalance(); break;
    case 'address': await cmdAddress(); break;
    case 'price': await cmdPrice(args[0]); break;
    case 'transfer': await cmdTransfer(args[0], args[1]); break;
    case 'swap': await cmdSwap(args[0], args[1], args[2]); break;
    case 'tokens': await cmdTokens(); break;
    default: console.log(`未知命令: ${cmd}。用 --help 查看帮助`);
  }
}

main().catch(e => { console.error('Error:', e.message); process.exit(1); });
