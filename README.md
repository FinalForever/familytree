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

## Docker 部署（推荐方式）

镜像已由 GitHub Actions 预构建并发布在 GHCR，部署时自动拉取，不需要在你的机器上编译代码；amd64 与 arm64 均支持。整个过程就三步：

### 第一步：准备

- 机器上装好 Docker（带 Compose 插件）：终端里 `docker --version` 和 `docker compose version` 都能输出版本号即可
- 拿到代码：`git clone https://github.com/FinalForever/familytree.git` 后 `cd familytree`（或下载 zip 解压后进入目录）

### 第二步：填配置（只需改两项必填）

```bash
cp .env.local.example .env   # 复制一份配置文件
```

用任意文本编辑器打开 `.env`，至少改好这两项（文件里每一项都有中文说明）：

- `AUTH_SECRET`：会话签名密钥，至少 16 位的随机长字符串，终端运行 `openssl rand -hex 32` 可现成生成一条
- `ADMIN_PASSWORD`：管理后台 `/admin` 的口令，部署完登录后台就用它；不填这一项，后台登不进去

改参数有两种方式，任选其一：默认改 `.env`（推荐）；或者直接写在 `docker-compose.yml` 里——文件中的 environment 一节有注释标明写法，那里写的值优先于 `.env`。

### 第三步：启动

```bash
docker compose up -d        # 拉镜像并启动
docker compose ps           # 状态显示 healthy 就是启动完成
```

浏览器打开 `http://localhost:3000`，能看到登录页就成功了。

### 部署完先做这几件事

1. 打开 `http://localhost:3000/admin`，用刚填的 `ADMIN_PASSWORD` 登录后台
2. 把家族姓氏改成你家的（保存后即时生效）
3. 决定注册开关：想让家人自己注册账号就保持开放；想只由你发账号就在后台关掉注册
4. 换上自己的族谱数据：把你的 `family-data.json` 放到 `config/` 目录覆盖自带的示例数据（格式见下一节），改完即时生效、不用重启

### 怎么从别的设备访问

默认只监听本机 `127.0.0.1:3000`，这是安全默认：

- **局域网访问**：把 `docker-compose.yml` 里端口一行改成 `"3000:3000"` 并重启，同一局域网内用 `http://机器的局域网IP:3000` 打开。注意这是明文 HTTP，只建议在可信的家里局域网这样用
- **公网访问**：强烈建议在前面套一层带 HTTPS 的反向代理（如 Nginx、Caddy）或隧道（如 Cloudflare Tunnel），不要把 3000 端口明文直接暴露到公网

### 日常运维

- 看日志：`docker compose logs -f`
- 重启：`docker compose restart`（改了 `.env` 或 compose 后用 `docker compose up -d` 让新配置生效）
- 更新到最新版：`docker compose pull && docker compose up -d`——账号和族谱数据都在 `config/`、`data/` 目录里，不会随更新丢失
- 备份：把 `config/` 和 `data/` 两个目录打包带走即可；恢复时放回原位重启
- 停止：`docker compose down`（只停容器，数据保留在目录里）

### 常见问题

- **`/admin` 登不进去**：多半是 `.env` 里没填 `ADMIN_PASSWORD`，或改完配置没重启容器（改完执行一次 `docker compose up -d`）
- **容器反复重启、页面报 500**：先看日志（`docker compose logs`）；最常见是 `AUTH_SECRET` 没填或短于 16 位
- **提示 3000 端口被占用**：把 compose 里端口映射左边的数字换一个，如 `"8080:3000"`，访问地址随之改成 8080 端口
- **换了族谱数据页面没变**：确认文件放在 `config/` 目录且是合法 JSON；格式坏了页面会回退成空数据，先在本机用 JSON 校验工具检查一遍

想改源码自行构建镜像的话，见 `docker-compose.yml` 里的注释。


主要环境变量（`.env`，每一项在示例文件里都有详细注释）：

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `AUTH_SECRET` | 是 | 会话令牌签名密钥，至少 16 位的随机长字符串（`openssl rand -hex 32` 生成） |
| `ADMIN_PASSWORD` | 是 | 管理后台 `/admin` 的管理员口令，不填则后台无法登录 |
| `REGISTRATION_OPEN` | 否 | 注册开关：设为 `false` 时强制关闭注册（压过后台设置）；其他情况后台设置优先 |
| `REQUIRE_AUTH` | 否 | 是否必须登录才能查看，保持 `true` 即可，改成 `false` 等于公开族谱 |

数据与账号：

- 族谱数据在 `config/family-data.json`，修改后即时生效、无需重启
- 账号与站点设置存放在 `data/` 目录（`users.json`、`settings.json`、令牌吊销记录），请勿提交到仓库，也不要把真实数据提交到公开仓库

## 数据格式

`config/family-data.json` 为 `generations` 数组：每一世包含 `title`（如「第一世」）与 `people`，成员以 `id` 标识，并通过父母、配偶等字段的 id 建立关系。可参考仓库内的示例数据。

## 致谢

本项目源于上游开源项目 [qiaoshouqing/familytree](https://github.com/qiaoshouqing/familytree)，最初正是从它 fork 而来。感谢原作者把这套族谱网站以 MIT 许可开源，提供了族谱可视化的核心思路与基础代码，本仓库才得以站在这个起点上，完成之后的安全加固与账号化改造，并独立维护至今。特此致谢。

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

## Docker deployment (recommended)

The image is prebuilt by GitHub Actions and published to GHCR (`ghcr.io/finalforever/familytree:latest`); deployment pulls it automatically — nothing to compile on your machine. Both amd64 and arm64 are supported. Three steps:

### 1. Prerequisites

- Docker with the Compose plugin installed (`docker --version` and `docker compose version` should both print versions)
- Get the code: `git clone https://github.com/FinalForever/familytree.git`, then `cd familytree` (or unzip the downloaded archive)

### 2. Configure (only two values are required)

```bash
cp .env.local.example .env   # create your config file
```

Open `.env` in any text editor and set at least:

- `AUTH_SECRET` — signing key for session tokens, a random string of at least 16 characters; generate one with `openssl rand -hex 32`
- `ADMIN_PASSWORD` — password for the admin backend at `/admin`; without it, the backend cannot be signed into

Two equivalent ways to set values: edit `.env` (recommended), or write them directly in `docker-compose.yml` — the `environment` section there has comments showing how, and values set there take precedence over `.env`.

### 3. Start

```bash
docker compose up -d     # pull the image and start
docker compose ps        # wait until the status shows "healthy"
```

Open `http://localhost:3000` in a browser; the sign-in page means you are up.

### First things to do after deploying

1. Open `http://localhost:3000/admin` and sign in with the `ADMIN_PASSWORD` you just set
2. Change the family surname to yours (takes effect immediately)
3. Decide on registration: leave it open so family members can register themselves, or turn it off in the backend and issue accounts yourself
4. Replace the sample data: put your own `family-data.json` into the `config/` folder (format described below); changes take effect immediately, no restart needed

### Reaching it from other devices

By default the site only listens on `127.0.0.1:3000` of the host — a safe default:

- **LAN access**: change the port line in `docker-compose.yml` to `"3000:3000"` and restart; then use `http://<host LAN IP>:3000`. Note this is plain HTTP — only do this on a trusted home network
- **Public access**: put an HTTPS reverse proxy (Nginx, Caddy, …) or a tunnel (e.g. Cloudflare Tunnel) in front; do not expose port 3000 to the internet as plain HTTP

### Day-to-day operations

- Logs: `docker compose logs -f`
- Restart: `docker compose restart` (after editing `.env` or the compose file, run `docker compose up -d` so the new values apply)
- Update to the latest version: `docker compose pull && docker compose up -d` — accounts and genealogy data live in the `config/` and `data/` folders and survive updates
- Backup: archive the `config/` and `data/` folders; restore by putting them back and restarting
- Stop: `docker compose down` (containers stop; data stays in the folders)

### Troubleshooting

- **Cannot sign in to /admin**: usually `ADMIN_PASSWORD` is missing from `.env`, or the container was not restarted after editing it (run `docker compose up -d` once)
- **Container keeps restarting / pages return 500**: check the logs (`docker compose logs`); the most common cause is a missing `AUTH_SECRET` or one shorter than 16 characters
- **Port 3000 already in use**: change the left-hand number of the port mapping, e.g. `"8080:3000"`, and browse to port 8080 instead
- **Replaced the data but the page did not change**: make sure the file is in `config/` and is valid JSON; malformed data makes the page fall back to an empty tree

To build the image from source instead, see the comments in `docker-compose.yml`.


Main environment variables (`.env`; every entry is commented in detail in the example file):

| Variable | Required | Description |
| --- | --- | --- |
| `AUTH_SECRET` | Yes | Signing key for session tokens, a random string of at least 16 characters (generate with `openssl rand -hex 32`) |
| `ADMIN_PASSWORD` | Yes | Password for the admin backend at `/admin`; without it the backend cannot be signed into |
| `REGISTRATION_OPEN` | No | Registration switch: `false` force-closes registration (overrides the admin-backend setting); otherwise the backend setting takes precedence |
| `REQUIRE_AUTH` | No | Whether sign-in is required to view the tree; keep `true` — `false` makes the genealogy public |

Data and accounts:

- Genealogy data lives in `config/family-data.json` and takes effect immediately after editing, no restart needed
- Accounts and site settings are stored under `data/` (`users.json`, `settings.json`, token revocation records); do not commit them, and never commit real family data to a public repository

## Data format

`config/family-data.json` holds a `generations` array: each generation has a `title` (e.g. "Generation 1") and `people`; members carry an `id` and reference parents/spouses by id. See the sample data in the repository.

## Acknowledgments

This project began as a fork of the open-source project [qiaoshouqing/familytree](https://github.com/qiaoshouqing/familytree). Many thanks to its author for releasing this family tree website under the MIT License: the upstream code provided the core idea of the genealogy visualization and the foundation on which the security hardening and account-based rework in this repository were built. This repository is now maintained independently, with sincere gratitude for the work that made it possible.

## License

MIT (same as upstream)
