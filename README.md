# 族谱（Family Tree）

中文 | [English](#english)

基于 [Next.js](https://nextjs.org) 的家族族谱展示网站。本仓库在上游开源项目 [qiaoshouqing/familytree](https://github.com/qiaoshouqing/familytree) 的基础上，做了完整的安全加固与账号化改造：族谱数据不再公开下发，必须登录账号才能查看，并配有管理后台。

## 功能

- 多代族谱可视化展示（世系树图 + 世代列表）：树图可缩放、拖动平移，支系可折叠展开，每行有世代标尺，搜索时自动展开命中者的祖先链；成员关系链接与个人信息详情
- 按姓名、简介等信息搜索，匹配高亮
- 账号 + 密码登录后才能查看，未登录时不下发任何族谱数据
- 开放注册（管理员可在后台随时关闭）
- 管理后台 `/admin`：指定账号密码新建账号、重置密码、删除账号、开关注册、修改家族姓氏
- 家族姓氏为运行时设置：后台保存后标题、登录页、页眉页脚即时生效，无需重新构建

### 管理后台（/admin）的作用

后台是站点的唯一管理入口，与前台查看账号完全分离：用独立的管理员口令（环境变量 `ADMIN_PASSWORD`）登录，使用独立的会话 Cookie。管理员可以在后台：

- 指定账号和密码新建查看账号（不需要开放注册也能发账号）
- 为任意账号重置密码、删除账号（删号后该账号的已登录会话立即失效）
- 一键开启/关闭前台注册（即时生效，无需重启）
- 修改家族姓氏（即时生效）

## 安全改造（相对上游）

- **数据防爬**：族谱数据改由服务端渲染注入页面，删除了可一次性拖走全部数据的 JSON 接口；全站限速（同一 IP 60 次/分钟）；robots 与响应头禁止搜索引擎收录
- **账号安全**：密码以 scrypt 哈希存储，绝不存明文；会话为 HMAC-SHA256 签名令牌 + HttpOnly Cookie；登录、注册均有频率限制（10 次/10 分钟），且前台登录 10 分钟内失败 5 次即锁定来源 IP 30 分钟（锁定期内正确密码也不放行）；账号被删除后，其已登录会话立即失效
- **后台防爆破**：`/admin` 登录单独设防——按来源 IP 限流 5 次/10 分钟，10 分钟内失败 5 次即锁定该来源 30 分钟（期间正确口令也不放行），每次失败尝试都记入服务日志；再叠加全站 60 次/分钟的统一限速。站点只经 Cloudflare Tunnel 对外，限流按隧道透传的真实访客 IP 计数，无法靠伪造来源绕开。加上管理员口令本身为随机长字符串，暴力破解在速率上不可行
- **漏洞修复**：Next.js 升至 15.5.28、React 升至 19.3.1（覆盖 CVE-2025-55182 RSC 远程执行、CVE-2025-29927 中间件鉴权绕过）；`package-lock.json` 已在官方 npm 源重新生成（上游锁文件有 10 条 integrity 与官方仓库不一致且全部指向 npmmirror，原样无法 `npm ci`）；搜索高亮输出做了 HTML 转义，堵住存储型 XSS
- **部署加固**：Docker 容器只读根文件系统、`cap_drop: ALL`、`no-new-privileges`、内存/CPU/进程数上限、非 root 运行

## 快速开始（本地开发）

```bash
npm install
cp .env.local.example .env.local   # 按需填写
npm run dev
```

## Docker 部署

```bash
cp .env.local.example .env         # 填写 AUTH_SECRET 与 ADMIN_PASSWORD
docker compose up -d
```
镜像由 GitHub Actions 预构建并发布在 GHCR（`ghcr.io/finalforever/familytree:latest`），`up` 时自动拉取，无需本地构建；amd64 与 arm64 均支持。想改源码自行构建的话，见 `docker-compose.yml` 里的注释。


主要环境变量（`.env`）：

| 变量 | 说明 |
| --- | --- |
| `AUTH_SECRET` | 会话令牌签名密钥（必填，随机长字符串） |
| `ADMIN_PASSWORD` | 管理后台 `/admin` 的管理员口令 |
| `REGISTRATION_OPEN` | 注册开关：设为 `false` 时强制关闭注册（压过后台设置）；其他情况后台设置优先 |

数据与账号：

- 族谱数据在 `config/family-data.json`，修改后即时生效、无需重启
- 账号与站点设置存放在 `data/` 目录（`users.json`、`settings.json`），请勿提交到仓库

## 数据格式

`config/family-data.json` 为 `generations` 数组：每一世包含 `title`（如「第一世」）与 `people`，成员以 `id` 标识，并通过父母、配偶等字段的 id 建立关系。可参考仓库内的示例数据。

## 许可

MIT（沿用上游项目）

---

## English

# Family Tree

[中文](#族谱family-tree) | English

A family tree visualization website built with [Next.js](https://nextjs.org). This repository is a hardened, account-based rework of the upstream open-source project [qiaoshouqing/familytree](https://github.com/qiaoshouqing/familytree): genealogy data is no longer served publicly — visitors must sign in with an account, and an admin backend is included.

## Features

- Multi-generation family tree visualization (interactive tree graph + generation lists): zoomable, drag to pan, collapsible branches, a generation ruler on every row, and search auto-expands the match's ancestor chain; with relationship links and member details
- Search across names and biographies with match highlighting
- Account + password sign-in required; no genealogy data is sent to anonymous visitors
- Optional open registration (the admin can turn it off at any time)
- Admin backend at `/admin`: create accounts with chosen credentials, reset passwords, delete accounts, toggle registration, change the family surname
- The family surname is a runtime setting: saving it in the admin backend updates the title, sign-in page, header and footer immediately, with no rebuild

### What the admin backend (/admin) does

The admin backend is the site's only management entry point and is fully separate from viewer accounts: it signs in with its own administrator password (the `ADMIN_PASSWORD` environment variable) and uses its own session cookie. From the backend, the administrator can:

- Create viewer accounts with chosen usernames and passwords (accounts can be issued even while public registration is closed)
- Reset any account's password and delete accounts (a deleted account's live sessions are invalidated immediately)
- Turn public registration on or off with one click (takes effect immediately, no restart)
- Change the family surname (takes effect immediately)

## Security changes (vs. upstream)

- **Anti-scraping**: data is injected via server-side rendering; the JSON endpoint that returned the entire dataset in one call was removed. Site-wide rate limiting (60 requests/minute per IP); search engines are blocked via robots rules and response headers
- **Account security**: passwords are stored as scrypt hashes, never in plaintext; sessions are HMAC-SHA256 signed tokens in HttpOnly cookies; sign-in and registration are rate limited (10 attempts / 10 minutes), and 5 failed sign-ins within 10 minutes lock the source IP out for 30 minutes (even the correct password is refused during lockout); deleting an account invalidates its live sessions immediately
- **Admin brute-force protection**: `/admin` sign-in has its own dedicated defenses — rate limited to 5 attempts per 10 minutes per source IP, and 5 failures within 10 minutes lock that source out for 30 minutes (even the correct password is refused during lockout); every failed attempt is written to the service log. This sits on top of the site-wide 60 requests/minute limit. Because the site is exposed only through a Cloudflare Tunnel, limits are counted against the real visitor IP passed through the tunnel and cannot be dodged with forged source headers. Combined with a long random administrator password, brute force is rate-wise infeasible
- **Vulnerability fixes**: Next.js upgraded to 15.5.28 and React to 19.3.1 (covering CVE-2025-55182, an RSC remote code execution flaw, and CVE-2025-29927, a middleware authorization bypass); `package-lock.json` was regenerated against the official npm registry (the upstream lockfile had 10 integrity hashes that did not match the official registry and pointed entirely at npmmirror, so `npm ci` failed as-is); search highlighting output is HTML-escaped, closing a stored-XSS hole
- **Deployment hardening**: the Docker container runs with a read-only root filesystem, `cap_drop: ALL`, `no-new-privileges`, memory/CPU/PID limits and a non-root user

## Quick start (local development)

```bash
npm install
cp .env.local.example .env.local   # fill in as needed
npm run dev
```

## Docker deployment

```bash
cp .env.local.example .env         # set AUTH_SECRET and ADMIN_PASSWORD
docker compose up -d
```
The image is prebuilt by GitHub Actions and published to GHCR (`ghcr.io/finalforever/familytree:latest`); `up` pulls it automatically — no local build needed. Both amd64 and arm64 are supported. To build from source instead, see the comments in `docker-compose.yml`.


Main environment variables (`.env`):

| Variable | Description |
| --- | --- |
| `AUTH_SECRET` | Signing key for session tokens (required, long random string) |
| `ADMIN_PASSWORD` | Password for the admin backend at `/admin` |
| `REGISTRATION_OPEN` | Registration switch: `false` force-closes registration (overrides the admin-backend setting); otherwise the backend setting takes precedence |

Data and accounts:

- Genealogy data lives in `config/family-data.json` and takes effect immediately after editing, no restart needed
- Accounts and site settings are stored under `data/` (`users.json`, `settings.json`); do not commit them

## Data format

`config/family-data.json` holds a `generations` array: each generation has a `title` (e.g. "Generation 1") and `people`; members carry an `id` and reference parents/spouses by id. See the sample data in the repository.

## License

MIT (same as upstream)
