// 安全回归冒烟测试：把历次安全修复的关键行为固化成可重复执行的检查。
// 前置：先完成生产构建（npm run build），脚本直接跑 .next/standalone 产物。
// 用法：node scripts/smoke.mjs [--data <family-data.json 路径，默认 config/family-data.json>]
// 覆盖：Secure/ HttpOnly Cookie、超长口令拒绝、分块大请求体 413、XFF 首项伪造仍被锁定、
//       改密后旧令牌失效、退出吊销令牌、管理员口令轮换后旧管理员令牌失效、
//       REGISTRATION_OPEN=false 压过后台设置、父子成环数据回退不死循环、
//       吊销落盘重启不复活、空白/过短签名密钥被拒、并发注册不丢号不重名、慢发完整请求体不误杀。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const dataIdx = args.indexOf('--data');
const dataPath = dataIdx >= 0 ? args[dataIdx + 1] : path.join(root, 'config', 'family-data.json');

const serverJs = path.join(root, '.next', 'standalone', 'server.js');
if (!fs.existsSync(serverJs)) {
  console.error('未找到 .next/standalone/server.js，请先执行 npm run build');
  process.exit(2);
}
// standalone 需要静态资源在旁
const standaloneDir = path.join(root, '.next', 'standalone');
if (!fs.existsSync(path.join(standaloneDir, '.next', 'static')) && fs.existsSync(path.join(root, '.next', 'static'))) {
  fs.cpSync(path.join(root, '.next', 'static'), path.join(standaloneDir, '.next', 'static'), { recursive: true });
}
if (!fs.existsSync(path.join(standaloneDir, 'public')) && fs.existsSync(path.join(root, 'public'))) {
  fs.cpSync(path.join(root, 'public'), path.join(standaloneDir, 'public'), { recursive: true });
}

const familyData = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
const markerName = familyData.generations?.[0]?.people?.[0]?.name;
if (!markerName) {
  console.error('数据文件里找不到第一个人物姓名，无法做渲染断言');
  process.exit(2);
}

const AUTH_SECRET = 'smoke-test-secret-key-0123456789';
const ADMIN_A = 'admin-pass-a';
const ADMIN_B = 'admin-pass-b';

// 哨兵：故意给父进程设一个不该被用到的 USERS_FILE——子进程环境里会被钉死到各自临时目录，
// 结尾断言这个哨兵文件从未被创建，证明冒烟绝不会写到真实账号文件
const SENTINEL_USERS_FILE = path.join(os.tmpdir(), 'ft-smoke-sentinel', 'users.json');
process.env.USERS_FILE = SENTINEL_USERS_FILE;

// 子进程清理：脚本异常退出时把拉起的 standalone 服务一并带走，不留孤儿进程
const liveChildren = new Set();
function killLiveChildren() {
  for (const c of liveChildren) {
    try {
      c.kill('SIGKILL');
    } catch {
      // 已退出
    }
  }
}
process.on('exit', killLiveChildren);
process.on('SIGINT', () => {
  killLiveChildren();
  process.exit(130);
});
process.on('SIGTERM', () => {
  killLiveChildren();
  process.exit(143);
});

let passed = 0;
let failed = 0;
function check(name, cond, extra = '') {
  if (cond) {
    passed += 1;
    console.log(`  PASS ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${name} ${extra}`);
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
    srv.on('error', reject);
  });
}

async function startServer({ settings, data, env, dir: reuseDir }) {
  const dir = reuseDir || fs.mkdtempSync(path.join(os.tmpdir(), 'ft-smoke-'));
  if (!reuseDir) {
    fs.mkdirSync(path.join(dir, 'config'));
    fs.mkdirSync(path.join(dir, 'data'));
    fs.writeFileSync(path.join(dir, 'config', 'family-data.json'), JSON.stringify(data));
    if (settings !== undefined) {
      fs.writeFileSync(path.join(dir, 'data', 'settings.json'), JSON.stringify(settings));
    }
  }
  const port = await freePort();
  const child = spawn(process.execPath, [serverJs], {
    cwd: standaloneDir,
    env: {
      ...process.env,
      PORT: String(port),
      HOSTNAME: '127.0.0.1',
      NODE_ENV: 'production',
      CONFIG_DIR: path.join(dir, 'config'),
      DATA_DIR: path.join(dir, 'data'),
      AUTH_SECRET,
      ...env,
      // 账号文件强制钉在本阶段的临时目录（在 ...env 之后，谁也别想覆盖）：
      // users.ts 里 USERS_FILE 优先于 DATA_DIR，父环境若设了它，冒烟会写到真实账号文件
      USERS_FILE: path.join(dir, 'data', 'users.json'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  liveChildren.add(child);
  child.once('exit', () => liveChildren.delete(child));
  let logs = '';
  child.stdout.on('data', (d) => (logs += d));
  child.stderr.on('data', (d) => (logs += d));
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 45000;
  for (;;) {
    try {
      const r = await fetch(base + '/');
      if (r.status === 200) break;
    } catch {
      // 还没起来
    }
    if (Date.now() > deadline) throw new Error(`服务器 45 秒未就绪\n${logs}`);
    await new Promise((r) => setTimeout(r, 500));
  }
  let stopped = false;
  return {
    base,
    dir,
    logs: () => logs,
    async stop(keepDir = false) {
      if (stopped) return;
      stopped = true;
      child.kill('SIGINT');
      await Promise.race([
        new Promise((r) => child.once('exit', r)),
        new Promise((r) => setTimeout(r, 3000)),
      ]);
      child.kill('SIGKILL');
      if (!keepDir) fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

function cookieOf(res, name) {
  const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get('set-cookie') || ''];
  for (const sc of setCookies) {
    const m = sc.match(new RegExp(`(?:^|,\\s*)${name}=([^;]+)`));
    if (m) return { value: m[1], raw: sc };
  }
  return null;
}

async function postJson(base, url, body, headers = {}) {
  return fetch(base + url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

async function delJson(base, url, body, headers = {}) {
  return fetch(base + url, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

async function getHome(base, token) {
  const r = await fetch(base + '/', { headers: token ? { cookie: `ft_session=${token}` } : {} });
  return { status: r.status, text: await r.text() };
}

// ---------- 阶段 A：常规安全行为 ----------
console.log('阶段 A：Cookie / 口令上限 / 请求体 / 限流键 / 令牌版本 / 退出吊销');
{
  const srv = await startServer({ settings: {}, data: familyData, env: { ADMIN_PASSWORD: ADMIN_A } });
  try {
    const home = await getHome(srv.base, null);
    check('未登录首页 200 且是登录页', home.status === 200 && home.text.includes('登录'));

    const reg = await postJson(srv.base, '/api/auth/register', { username: 'smokeuser', password: 'password123' });
    const sc = cookieOf(reg, 'ft_session');
    check('注册成功', reg.status === 200, `实际 ${reg.status}`);
    check('会话 Cookie 带 Secure', !!sc && /;\s*Secure/i.test(sc.raw));
    check('会话 Cookie 带 HttpOnly', !!sc && /;\s*HttpOnly/i.test(sc.raw));
    const token1 = sc?.value;

    const logged = await getHome(srv.base, token1);
    check('登录后能看到家谱数据', logged.status === 200 && logged.text.includes(markerName));

    const longPw = await postJson(srv.base, '/api/auth/register', { username: 'smokeuser2', password: 'x'.repeat(129) });
    check('129 位口令注册被拒 400', longPw.status === 400, `实际 ${longPw.status}`);

    const bigBody = JSON.stringify({ username: 'chunky', password: 'password123', pad: 'x'.repeat(40000) });
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode(bigBody));
        c.close();
      },
    });
    const chunked = await fetch(srv.base + '/api/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: stream,
      duplex: 'half',
    });
    check('分块传输的超大请求体被拒 413', chunked.status === 413, `实际 ${chunked.status}`);

    let lastStatus = 0;
    for (let i = 1; i <= 5; i += 1) {
      const r = await postJson(
        srv.base,
        '/api/auth',
        { username: 'smokeuser', password: 'wrongpass1' },
        { 'x-forwarded-for': `${i}.10.10.10, 5.5.5.5` }
      );
      lastStatus = r.status;
    }
    check('伪造 XFF 首项轮换时错密仍计入同一来源（5 次均 401）', lastStatus === 401, `实际 ${lastStatus}`);
    const sixth = await postJson(
      srv.base,
      '/api/auth',
      { username: 'smokeuser', password: 'password123' },
      { 'x-forwarded-for': '9.9.9.9, 5.5.5.5' }
    );
    check('第 6 次正确口令也因失败锁定被拒 429', sixth.status === 429, `实际 ${sixth.status}`);

    const login = await postJson(srv.base, '/api/auth', { username: 'smokeuser', password: 'password123' });
    check('干净来源可正常登录', login.status === 200, `实际 ${login.status}`);

    const adminLogin = await postJson(srv.base, '/api/admin/login', { password: ADMIN_A });
    const ac = cookieOf(adminLogin, 'ft_admin');
    check('管理员登录成功', adminLogin.status === 200, `实际 ${adminLogin.status}`);
    check('管理员 Cookie 带 Secure', !!ac && /;\s*Secure/i.test(ac.raw));
    const adminToken = ac?.value;

    const reset = await postJson(
      srv.base,
      '/api/admin/users/password',
      { username: 'smokeuser', password: 'newpassword456' },
      { cookie: `ft_admin=${adminToken}` }
    );
    check('管理员改密成功', reset.status === 200, `实际 ${reset.status}`);
    const stale = await getHome(srv.base, token1);
    check('改密后旧令牌失效（看不到数据）', stale.status === 200 && !stale.text.includes(markerName));

    const login2 = await postJson(srv.base, '/api/auth', { username: 'smokeuser', password: 'newpassword456' });
    const token2 = cookieOf(login2, 'ft_session')?.value;
    check('新口令可登录', login2.status === 200, `实际 ${login2.status}`);
    const before = await getHome(srv.base, token2);
    check('新令牌能看数据', before.text.includes(markerName));
    await postJson(srv.base, '/api/auth/logout', {}, { cookie: `ft_session=${token2}` });
    const after = await getHome(srv.base, token2);
    check('退出后同一令牌被吊销（看不到数据）', after.status === 200 && !after.text.includes(markerName));

    const regState = await fetch(srv.base + '/api/admin/registration', { headers: { cookie: `ft_admin=${adminToken}` } });
    check('管理员令牌可用', regState.status === 200, `实际 ${regState.status}`);
    await postJson(srv.base, '/api/admin/logout', {}, { cookie: `ft_admin=${adminToken}` });
    const regState2 = await fetch(srv.base + '/api/admin/registration', { headers: { cookie: `ft_admin=${adminToken}` } });
    check('管理员退出后令牌被吊销 401', regState2.status === 401, `实际 ${regState2.status}`);

    // 重启持久化：吊销表落盘后，重启进程被吊销的令牌不能复活
    check('吊销表已落盘', fs.existsSync(path.join(srv.dir, 'data', 'revoked-tokens.json')));
    await srv.stop(true);
    const srv2 = await startServer({ dir: srv.dir, env: { ADMIN_PASSWORD: ADMIN_A } });
    try {
      const afterRestart = await getHome(srv2.base, token2);
      check('重启后已吊销令牌仍失效', afterRestart.status === 200 && !afterRestart.text.includes(markerName));
      const relogin = await postJson(srv2.base, '/api/auth', { username: 'smokeuser', password: 'newpassword456' });
      check('重启后正常登录不受影响', relogin.status === 200, `实际 ${relogin.status}`);
    } finally {
      await srv2.stop();
    }

    // 把管理员令牌留给阶段 B 验证口令轮换
    globalThis.__adminTokenA = adminToken;
  } finally {
    await srv.stop(true).catch(() => undefined);
  }
}

// ---------- 阶段 B：env 强制关注册 + 管理员口令轮换 ----------
console.log('阶段 B：REGISTRATION_OPEN=false 压过后台设置 / 管理员口令轮换');
{
  const srv = await startServer({
    settings: { registrationOpen: true },
    data: familyData,
    env: { ADMIN_PASSWORD: ADMIN_B, REGISTRATION_OPEN: 'false' },
  });
  try {
    const reg = await postJson(srv.base, '/api/auth/register', { username: 'lateuser', password: 'password123' });
    check('后台开着但 env=false 时注册仍 403', reg.status === 403, `实际 ${reg.status}`);

    const cross = await fetch(srv.base + '/api/admin/registration', {
      headers: { cookie: `ft_admin=${globalThis.__adminTokenA}` },
    });
    check('管理员口令轮换后旧管理员令牌失效 401', cross.status === 401, `实际 ${cross.status}`);

    const oldLogin = await postJson(srv.base, '/api/admin/login', { password: ADMIN_A });
    check('旧管理员口令被拒 401', oldLogin.status === 401, `实际 ${oldLogin.status}`);
    const newLogin = await postJson(srv.base, '/api/admin/login', { password: ADMIN_B });
    check('新管理员口令可登录', newLogin.status === 200, `实际 ${newLogin.status}`);
  } finally {
    await srv.stop();
  }
}

// ---------- 阶段 C：父子成环数据 ----------
console.log('阶段 C：家谱数据成环时回退、不死循环');
{
  const cyclic = {
    generations: [
      { title: '第一世', people: [{ id: 'a', name: '环测甲', info: '', fatherId: 'b' }] },
      { title: '第二世', people: [{ id: 'b', name: '环测乙', info: '', fatherId: 'a' }] },
    ],
  };
  const srv = await startServer({ settings: {}, data: cyclic, env: { ADMIN_PASSWORD: ADMIN_A } });
  try {
    // 数据只在登录后的页面请求里加载，校验也在那时跑：先注册登录再取首页
    const reg = await postJson(srv.base, '/api/auth/register', { username: 'cycuser', password: 'password123' });
    const token = cookieOf(reg, 'ft_session')?.value;
    check('成环数据时注册仍成功', reg.status === 200, `实际 ${reg.status}`);
    const home = await getHome(srv.base, token);
    check('成环数据时首页仍 200（不死循环）', home.status === 200, `实际 ${home.status}`);
    check('成环数据未被渲染（已回退）', !home.text.includes('环测甲'));
    check('日志打出结构校验未通过', srv.logs().includes('family-data.json 结构校验未通过'));
  } finally {
    await srv.stop();
  }
}

// ---------- 阶段 D：空白/过短签名密钥按未配置处理 ----------
console.log('阶段 D：空白/过短 AUTH_SECRET 被拒绝');
{
  const srv = await startServer({ settings: {}, data: familyData, env: { ADMIN_PASSWORD: ADMIN_A, AUTH_SECRET: '   ' } });
  try {
    const login = await postJson(srv.base, '/api/auth', { username: 'whoever', password: 'password123' });
    check('全空格密钥时前台登录 500', login.status === 500, `实际 ${login.status}`);
    const adminLogin = await postJson(srv.base, '/api/admin/login', { password: ADMIN_A });
    check('全空格密钥时管理员登录 500', adminLogin.status === 500, `实际 ${adminLogin.status}`);
  } finally {
    await srv.stop();
  }
  const srv2 = await startServer({ settings: {}, data: familyData, env: { ADMIN_PASSWORD: ADMIN_A, AUTH_SECRET: 'short' } });
  try {
    const login = await postJson(srv2.base, '/api/auth', { username: 'whoever', password: 'password123' });
    check('过短密钥时前台登录 500', login.status === 500, `实际 ${login.status}`);
  } finally {
    await srv2.stop();
  }
}

// ---------- 阶段 E：并发注册不丢号、不重名 ----------
console.log('阶段 E：并发注册（互斥锁 + 锁内查重）');
{
  const srv = await startServer({ settings: {}, data: familyData, env: { ADMIN_PASSWORD: ADMIN_A } });
  try {
    const same = await Promise.all(
      Array.from({ length: 5 }, () => postJson(srv.base, '/api/auth/register', { username: 'raceuser', password: 'password123' }))
    );
    const okCount = same.filter((r) => r.status === 200).length;
    const dupCount = same.filter((r) => r.status === 409).length;
    check('同名并发注册恰好成功 1 个', okCount === 1, `实际成功 ${okCount}`);
    check('同名并发注册其余均 409', dupCount === 4, `实际 409 共 ${dupCount}`);
    const distinct = await Promise.all(
      ['race1', 'race2', 'race3', 'race4'].map((u) => postJson(srv.base, '/api/auth/register', { username: u, password: 'password123' }))
    );
    check('不同名并发注册全部成功', distinct.every((r) => r.status === 200), `实际 ${distinct.map((r) => r.status).join(',')}`);
    const usersFile = path.join(srv.dir, 'data', 'users.json');
    const users = JSON.parse(fs.readFileSync(usersFile, 'utf8'));
    const names = users.map((u) => u.username);
    check('账号文件里 raceuser 恰好一条', names.filter((n) => n === 'raceuser').length === 1);
    check('账号文件共 5 条且无丢失', names.length === 5, `实际 ${names.length}`);
  } finally {
    await srv.stop();
  }
}

// ---------- 阶段 F：慢速分块发送的完整请求体不被误杀 ----------
// Next standalone 先收完请求体再进 handler，应用层「读取时限」无从生效（裸 socket 实测）；
// 这里只断言真实成立的行为：慢发但最终完整的合法请求体应被正常处理（错密 → 401）。
console.log('阶段 F：慢发完整请求体正常处理');
{
  const srv = await startServer({ settings: {}, data: familyData, env: { ADMIN_PASSWORD: ADMIN_A } });
  try {
    const parts = ['{"username":"slowuser",', '"password":"wrongpass1"', '}'];
    let i = 0;
    const stream = new ReadableStream({
      async pull(c) {
        if (i >= parts.length) {
          c.close();
          return;
        }
        await new Promise((r) => setTimeout(r, 700));
        c.enqueue(new TextEncoder().encode(parts[i]));
        i += 1;
      },
    });
    const res = await Promise.race([
      fetch(srv.base + '/api/auth', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: stream,
        duplex: 'half',
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('client-wait-timeout')), 10000)),
    ]).catch(() => null);
    check('慢发完整请求体被正常处理（错密 401）', res?.status === 401, `实际 ${res ? res.status : '无响应'}`);
  } finally {
    await srv.stop();
  }
}

// ---------- 阶段 G：吊销存储 fail-closed ----------
console.log('阶段 G：吊销存储 fail-closed（损坏/写失败/无效令牌）');
{
  // G1：吊销文件损坏后重启，已吊销令牌不能复活，新会话也建不起来
  const srv = await startServer({ settings: {}, data: familyData, env: { ADMIN_PASSWORD: ADMIN_A } });
  const dirG = srv.dir;
  try {
    const reg = await postJson(srv.base, '/api/auth/register', { username: 'guser', password: 'password123' });
    const token = cookieOf(reg, 'ft_session')?.value;
    await postJson(srv.base, '/api/auth/logout', {}, { cookie: `ft_session=${token}` });
    await srv.stop(true);
    fs.writeFileSync(path.join(dirG, 'data', 'revoked-tokens.json'), '损坏的内容{{{');
    const srv2 = await startServer({ dir: dirG, env: { ADMIN_PASSWORD: ADMIN_A } });
    try {
      const home = await getHome(srv2.base, token);
      check('吊销文件损坏后已吊销令牌仍被拒', home.status === 200 && !home.text.includes(markerName));
      const login = await postJson(srv2.base, '/api/auth', { username: 'guser', password: 'password123' });
      check(
        '吊销文件损坏时登录返回 503 且不发 Cookie',
        login.status === 503 && !cookieOf(login, 'ft_session'),
        `实际 ${login.status}`
      );
      const adminLogin = await postJson(srv2.base, '/api/admin/login', { password: ADMIN_A });
      check('吊销文件损坏时管理员登录返回 503', adminLogin.status === 503, `实际 ${adminLogin.status}`);
      check('日志记录吊销表故障', srv2.logs().includes('吊销表'));
    } finally {
      await srv2.stop();
    }
  } finally {
    await srv.stop(true).catch(() => undefined);
  }

  // G2：写盘失败时注销报 500、不假成功，令牌保持有效
  const srv3 = await startServer({ settings: {}, data: familyData, env: { ADMIN_PASSWORD: ADMIN_A } });
  try {
    const reg1 = await postJson(srv3.base, '/api/auth/register', { username: 'gtwo1', password: 'password123' });
    const t1 = cookieOf(reg1, 'ft_session')?.value;
    const okOut = await postJson(srv3.base, '/api/auth/logout', {}, { cookie: `ft_session=${t1}` });
    check('正常注销成功（吊销文件已生成）', okOut.status === 200, `实际 ${okOut.status}`);
    const reg2 = await postJson(srv3.base, '/api/auth/register', { username: 'gtwo2', password: 'password123' });
    const t2 = cookieOf(reg2, 'ft_session')?.value;
    const revokedPath = path.join(srv3.dir, 'data', 'revoked-tokens.json');
    fs.rmSync(revokedPath, { force: true });
    fs.mkdirSync(revokedPath); // 用同名目录占位，让落盘的 rename 必然失败
    const badOut = await postJson(srv3.base, '/api/auth/logout', {}, { cookie: `ft_session=${t2}` });
    check('写盘失败时注销返回 500', badOut.status === 500, `实际 ${badOut.status}`);
    const home = await getHome(srv3.base, t2);
    check('注销失败后令牌保持有效（未假吊销）', home.text.includes(markerName));
  } finally {
    await srv3.stop();
  }

  // G3：无效令牌登出不写入吊销文件
  const srv4 = await startServer({ settings: {}, data: familyData, env: { ADMIN_PASSWORD: ADMIN_A } });
  try {
    for (let i = 0; i < 5; i += 1) {
      await postJson(srv4.base, '/api/auth/logout', {}, { authorization: `Bearer junk-token-${i}` });
    }
    const p = path.join(srv4.dir, 'data', 'revoked-tokens.json');
    const entries = fs.existsSync(p) ? Object.keys(JSON.parse(fs.readFileSync(p, 'utf8'))).length : 0;
    check('无效令牌不写入吊销文件', entries === 0, `实际 ${entries} 条`);
  } finally {
    await srv4.stop();
  }
}

// ---------- 阶段 H：登录验证与改密竞态（20 次并发） ----------
console.log('阶段 H：登录/改密竞态循环');
{
  const srv = await startServer({ settings: {}, data: familyData, env: { ADMIN_PASSWORD: ADMIN_A } });
  try {
    const adminLogin = await postJson(srv.base, '/api/admin/login', { password: ADMIN_A });
    const adminToken = cookieOf(adminLogin, 'ft_admin')?.value;
    let raceOk = true;
    for (let i = 0; i < 20; i += 1) {
      const username = `race${i}`;
      const key = { 'x-forwarded-for': `1.1.1.1, 9.9.9.${i}` };
      await postJson(srv.base, '/api/auth/register', { username, password: 'oldpass123' }, key);
      const [loginRes] = await Promise.all([
        postJson(srv.base, '/api/auth', { username, password: 'oldpass123' }, key),
        postJson(
          srv.base,
          '/api/admin/users/password',
          { username, password: 'newpass456' },
          { cookie: `ft_admin=${adminToken}` }
        ),
      ]);
      if (loginRes.status === 200) {
        const t = cookieOf(loginRes, 'ft_session')?.value;
        const home = await getHome(srv.base, t);
        if (home.text.includes(markerName)) raceOk = false;
      }
      const oldLogin = await postJson(srv.base, '/api/auth', { username, password: 'oldpass123' }, key);
      if (oldLogin.status !== 401) raceOk = false;
      const newLogin = await postJson(srv.base, '/api/auth', { username, password: 'newpass456' }, key);
      if (newLogin.status !== 200) raceOk = false;
    }
    check('20 次竞态中旧密码从未签出有效会话且新密码可用', raceOk);
    const users = JSON.parse(fs.readFileSync(path.join(srv.dir, 'data', 'users.json'), 'utf8'));
    const names = users.map((u) => u.username);
    check('竞态后账号文件 20 条无重复无丢失', names.length === 20 && new Set(names).size === 20, `实际 ${names.length} 条`);
  } finally {
    await srv.stop();
  }
}

// ---------- 阶段 I：账号世代绑定 + 吊销加载校验 ----------
console.log('阶段 I：删号重建复活 / 吊销超限加载');
{
  // I1：删号后同名重建，旧令牌不能复活（令牌绑账号随机 id，不只绑用户名+版本号）
  const srv = await startServer({ settings: {}, data: familyData, env: { ADMIN_PASSWORD: ADMIN_A } });
  try {
    const adminLogin = await postJson(srv.base, '/api/admin/login', { password: ADMIN_A });
    const adminToken = cookieOf(adminLogin, 'ft_admin')?.value;
    const reg = await postJson(srv.base, '/api/auth/register', { username: 'ghost', password: 'password123' });
    const oldToken = cookieOf(reg, 'ft_session')?.value;
    const homeBefore = await getHome(srv.base, oldToken);
    check('重建前旧令牌可用（对照）', homeBefore.text.includes(markerName));
    const del = await delJson(srv.base, '/api/admin/users', { username: 'ghost' }, { cookie: `ft_admin=${adminToken}` });
    check('管理员删号成功', del.status === 200, `实际 ${del.status}`);
    const recreate = await postJson(
      srv.base,
      '/api/admin/users',
      { username: 'ghost', password: 'password123' },
      { cookie: `ft_admin=${adminToken}` }
    );
    check('管理员重建同名账号成功', recreate.status === 200, `实际 ${recreate.status}`);
    const homeAfter = await getHome(srv.base, oldToken);
    check('同名重建后旧令牌不能复活', !homeAfter.text.includes(markerName));
    const relogin = await postJson(srv.base, '/api/auth', { username: 'ghost', password: 'password123' });
    const homeNew = await getHome(srv.base, cookieOf(relogin, 'ft_session')?.value);
    check('重建账号新登录正常', homeNew.text.includes(markerName));
  } finally {
    await srv.stop();
  }

  // I2：吊销文件预置超上限的有效条目，启动加载即 fail-closed
  const srvB = await startServer({ settings: {}, data: familyData, env: { ADMIN_PASSWORD: ADMIN_A } });
  const dirB = srvB.dir;
  try {
    const reg = await postJson(srvB.base, '/api/auth/register', { username: 'capuser', password: 'password123' });
    const token = cookieOf(reg, 'ft_session')?.value;
    await srvB.stop(true);
    const entries = {};
    const exp = Date.now() + 3600_000;
    for (let i = 0; i < 10001; i += 1) entries[i.toString(16).padStart(64, '0')] = exp;
    fs.writeFileSync(path.join(dirB, 'data', 'revoked-tokens.json'), JSON.stringify(entries));
    const srvB2 = await startServer({ dir: dirB, env: { ADMIN_PASSWORD: ADMIN_A } });
    try {
      const home = await getHome(srvB2.base, token);
      check('吊销表超上限时启动 fail-closed（会话被拒）', !home.text.includes(markerName));
      check('日志记录吊销表超限', srvB2.logs().includes('超过上限'));
    } finally {
      await srvB2.stop();
    }
  } finally {
    await srvB.stop(true).catch(() => undefined);
  }
}

check('哨兵 USERS_FILE 从未被使用（冒烟未写真实账号文件）', !fs.existsSync(SENTINEL_USERS_FILE));

console.log(`\n结果：${passed} 通过，${failed} 失败`);
process.exit(failed ? 1 : 0);
