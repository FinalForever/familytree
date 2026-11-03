// 安全回归冒烟测试：把历次安全修复的关键行为固化成可重复执行的检查。
// 前置：先完成生产构建（npm run build），脚本直接跑 .next/standalone 产物。
// 用法：node scripts/smoke.mjs [--data <family-data.json 路径，默认 config/family-data.json>]
// 覆盖：Secure/ HttpOnly Cookie、超长口令拒绝、分块大请求体 413、XFF 首项伪造仍被锁定、
//       改密后旧令牌失效、退出吊销令牌、管理员口令轮换后旧管理员令牌失效、
//       REGISTRATION_OPEN=false 压过后台设置、父子成环数据回退不死循环。
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

const AUTH_SECRET = 'smoke-secret';
const ADMIN_A = 'admin-pass-a';
const ADMIN_B = 'admin-pass-b';

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

async function startServer({ settings, data, env }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-smoke-'));
  fs.mkdirSync(path.join(dir, 'config'));
  fs.mkdirSync(path.join(dir, 'data'));
  fs.writeFileSync(path.join(dir, 'config', 'family-data.json'), JSON.stringify(data));
  if (settings !== undefined) {
    fs.writeFileSync(path.join(dir, 'data', 'settings.json'), JSON.stringify(settings));
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
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
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
  return {
    base,
    logs: () => logs,
    async stop() {
      child.kill('SIGINT');
      await Promise.race([
        new Promise((r) => child.once('exit', r)),
        new Promise((r) => setTimeout(r, 3000)),
      ]);
      child.kill('SIGKILL');
      fs.rmSync(dir, { recursive: true, force: true });
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

    // 把管理员令牌留给阶段 B 验证口令轮换
    globalThis.__adminTokenA = adminToken;
  } finally {
    await srv.stop();
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

console.log(`\n结果：${passed} 通过，${failed} 失败`);
process.exit(failed ? 1 : 0);
