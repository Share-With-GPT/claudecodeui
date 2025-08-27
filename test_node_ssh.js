// test_node_ssh.mjs
// Usage:
//   SSH_PASSWORD=xxx node test_node_ssh.mjs
//   或设置 SSH_KEY_PASSPHRASE 用于加密私钥
//   默认尝试顺序：ssh-agent → id_ed25519 → id_rsa → password

import { NodeSSH } from 'node-ssh';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOST = '127.0.0.1';
const PORT = 22;
const USER = os.userInfo().username;
const PY = 'python3';
const SCRIPT = 'test_argv.py';

function firstExists(paths) {
  for (const p of paths) {
    try { if (fs.statSync(p).isFile()) return p; } catch {}
  }
  return null;
}

// Build auth strategy list (will try in order)
function buildAuthStrategies() {
  const strategies = [];

  // 1) ssh-agent
  if (process.env.SSH_AUTH_SOCK) {
    strategies.push({
      name: 'ssh-agent',
      options: { agent: process.env.SSH_AUTH_SOCK },
    });
  }

  // 2) id_ed25519 / id_rsa (private key files)
  const home = os.homedir();
  const keyPath = firstExists([
    path.join(home, '.ssh', 'id_ed25519'),
    path.join(home, '.ssh', 'id_rsa'),
  ]);
  if (keyPath) {
    strategies.push({
      name: `privateKey:${keyPath}`,
      options: {
        privateKey: fs.readFileSync(keyPath, 'utf8'),
        passphrase: process.env.SSH_KEY_PASSPHRASE,
      },
    });
  }

  // 3) password (from env)
  if (process.env.SSH_PASSWORD) {
    strategies.push({
      name: 'password',
      options: { password: process.env.SSH_PASSWORD },
    });
  }

  return strategies;
}

async function connectWithFallback(ssh) {
  const strategies = buildAuthStrategies();
  if (strategies.length === 0) {
    throw new Error(
      '没有发现可用的认证方式：缺少 SSH_AUTH_SOCK、私钥文件(~/.ssh/id_ed25519|id_rsa) 或 SSH_PASSWORD 环境变量。'
    );
  }

  let lastErr;
  for (const s of strategies) {
    console.log(`尝试认证方式: ${s.name}`);
    try {
      await ssh.connect({
        host: HOST,
        port: PORT,
        username: USER,
        ...s.options,
        tryKeyboard: true,
        onKeyboardInteractive: (name, instructions, instructionsLang, prompts, finish) => {
          // Only answer if user explicitly provided SSH_PASSWORD
          if (prompts?.length && process.env.SSH_PASSWORD) {
            finish([process.env.SSH_PASSWORD]);
          } else {
            finish([]);
          }
        },
      });
      console.log(`✅ 认证成功: ${s.name}`);
      return;
    } catch (e) {
      console.log(`❌ 失败: ${s.name} -> ${e.message}`);
      lastErr = e;
      try { ssh.dispose(); } catch {}
    }
  }
  throw lastErr || new Error('All authentication methods failed.');
}

function shellescape(a) {
  var ret = [];

  a.forEach(function(s) {
    if (/[^A-Za-z0-9_\/:=-]/.test(s)) {
      s = "'"+s.replace(/'/g,"'\\''")+"'";
      s = s.replace(/^(?:'')+/g, '') // unduplicate single-quote at the beginning
        .replace(/\\'''/g, "\\'" ); // remove non-escaped single-quote if there are enclosed between 2 escaped
    }
    ret.push(s);
  });

  return ret.join(' ');
}

async function run() {
  const ssh = new NodeSSH();
  await connectWithFallback(ssh);

  const cases = [
    ['1 1'],
    ['a"b'],
    ['$HOME'],
    ['`uname -a`'],
    ['* ? [abc]'],
    ["O'Hara"],
    [`abc'; echo PWN; echo 'x`],
    [''], // empty string
    ['1', '', '3"'], // empty string
  ];

  for (const args of cases) {
    console.log('='.repeat(80));
    console.log(`CASE: ${JSON.stringify(args)}`);

    // simulate shell escape
    const escapedArgs = shellescape(args);
    console.log(`Escaped args: ${JSON.stringify(escapedArgs)}`);

    // 使用 exec(程序名, argv数组) 保留参数边界
    // ✅ 方案1：用 exec() + stream:'both'，保留 argv 边界最安全
    const result = await ssh.exec(PY, [SCRIPT, ...args], {
        stream: 'both',              // <-- 关键：返回 { stdout, stderr, code, signal }
        options: { pty: true },      // <-- 关键：PTY 要放在 options 下
    });
    console.log('--- STDOUT ---');
    console.log((result.stdout || '').trim());
    if ((result.stderr || '').trim()) {
        console.log('--- STDERR ---');
        console.log(result.stderr.trim());
    }
  }

  ssh.dispose();
  console.log('='.repeat(80));
  console.log('Done.');
}

run().catch((e) => {
  console.error(`运行失败: ${e.message}`);
  process.exit(1);
});
