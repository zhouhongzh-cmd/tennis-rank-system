# 2026-06-15 部署与加载速度优化说明

## 背景

本次将网球积分系统从临时 Node 进程迁移到 Docker 容器，并通过 Cloudflare Tunnel 绑定正式域名：

- 公网地址：`https://tennis.21481812.xyz/`
- 本机/Tailscale 地址：`http://100.88.114.27:3000/`
- Docker 容器名：`tennis-ranks`
- 管理密码环境变量：`TENNIS_ADMIN_PASSWORD=666666`
- SQLite 数据库挂载目录：`./data:/data`

由于 Docker Hub 拉取 `node:22-bookworm-slim` 在当前网络下出现 TLS handshake timeout，本次构建使用本机已有的 `ghcr.io/decolua/9router:latest` 作为 Node 22 基础镜像，并通过 `Dockerfile.local` 构建 `tennis-ranks:latest`。

## 主要变更

### 1. Docker 化运行

新增 `Dockerfile.local`，用于在当前机器网络条件下构建 tennis 镜像。

运行方式：

```bash
docker build -f Dockerfile.local -t tennis-ranks:latest .
docker run -d \
  --name tennis-ranks \
  --restart unless-stopped \
  -p 3000:3000 \
  -e TENNIS_ADMIN_PASSWORD=666666 \
  -e TENNIS_DB_FILE=/data/tennis.db \
  -e PORT=3000 \
  -v "$PWD/data:/data" \
  tennis-ranks:latest
```

这样做的理由：

- 容器重启策略为 `unless-stopped`，比临时 `nohup npm start` 更适合长期运行。
- 数据库通过 volume 挂载到宿主机 `data/`，容器重建不会丢数据。
- 与现有 9router 容器保持同样的 Docker 运维方式。

### 2. 数据库定时备份

新增脚本：

```text
scripts/backup-db.mjs
```

功能：

- 使用 `better-sqlite3` 的在线备份接口生成一致性备份。
- 默认备份 `data/tennis.db`。
- 默认输出到 `data/backups/`。
- 默认保留最近 30 天备份。

当前 crontab 示例：

```cron
0 3 * * * cd /home/hikiwa/.openclaw/workspace/repos/tennis-rank-system && TENNIS_DB_FILE='/home/hikiwa/.openclaw/workspace/repos/tennis-rank-system/data/tennis.db' TENNIS_BACKUP_DIR='/home/hikiwa/.openclaw/workspace/repos/tennis-rank-system/data/backups' TENNIS_BACKUP_RETENTION_DAYS=30 /usr/bin/env node scripts/backup-db.mjs >> tennis-backup.log 2>&1 # openclaw tennis-ranks db backup
```

这样做的理由：

- SQLite 数据库可能处于运行中，直接复制 db 文件不如在线备份接口稳。
- 自动保留最近 30 天，避免长期堆积占用磁盘。
- 备份文件与数据库同目录树，方便整体迁移。

### 3. Cloudflare Tunnel 正式域名

已创建 Cloudflare Tunnel：

- Tunnel 名称：`tennis`
- Tunnel ID：`c7f48504-0e41-4e0c-b5ae-9332fcdf9df1`
- Hostname：`tennis.21481812.xyz`
- Origin：`http://127.0.0.1:3000`

本机用户级 systemd 服务：

```text
~/.config/systemd/user/cloudflared-tennis.service
```

Cloudflared 配置：

```text
~/.cloudflared/tennis.yml
```

这样做的理由：

- 不需要开放公网入站端口。
- 可以用正式 HTTPS 域名访问。
- Tunnel 服务由 systemd 托管，重启后可自动恢复。

### 4. 移除 Google Fonts 外部依赖

`tennis_ranks.html` 原先引用了：

- `fonts.googleapis.com`
- `fonts.gstatic.com`

本次已全部移除，并改为系统字体栈：

- 正文字体：`system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`
- 等宽字体：`ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace`

这样做的理由：

- 手机端，尤其国内网络或内置浏览器，访问 Google Fonts 容易阻塞或超时。
- 页面本身只有约 40KB，外部字体才是明显拖慢首屏的因素。
- 系统字体可以立即渲染，避免 FOIT/FOUT 和跨境字体请求。

### 5. 首页内嵌初始数据，减少首屏 API 往返

修改 `server.js` 的 `sendHtml()`：

- 服务端读取当前 `exportState()`。
- 将初始 `players` / `matches` 数据注入到 HTML 中的 `window.__TENNIS_BOOTSTRAP__`。
- 前端 `load()` 优先使用内嵌数据渲染首屏。
- `/api/me` 改为后台异步检查，只影响是否显示录入权限，不阻塞排行榜首屏。

这样做的理由：

- 通过 Cloudflare Tunnel 访问时，每个公网请求都有约 0.8–1.5 秒延迟。
- 原首屏需要至少请求：
  - `/` HTML
  - `/api/state`
  - `/api/me`
- 手机网络下多次 HTTPS/Tunnel 往返会明显拖慢。
- 内嵌初始数据后，排行榜可随 HTML 一次返回并立即渲染。

### 6. 首页缓存策略调整

首页响应头调整为：

```http
Cache-Control: public, max-age=30, s-maxage=60
```

这样做的理由：

- 首页现在包含实时排行榜数据，不适合长时间强缓存。
- 30 秒浏览器缓存 + 60 秒边缘缓存可以减少短时间重复打开的延迟。
- 修改比赛后，最多可能有几十秒缓存延迟；如果需要立即看到最新数据，可以刷新或稍等。

## 优化效果

优化前后测得：

- 本地容器访问：约 `3ms`。
- Cloudflare Tunnel 公网访问：约 `0.8–1.5s`。
- 优化前手机首屏还会等待 Google Fonts 和额外 API 请求。
- 优化后页面不再依赖外部字体，排行榜初始数据随 HTML 返回，手机首屏体感明显变快。

需要注意：Cloudflare 当前边缘连接显示为 LAX，国内手机网络到 Cloudflare Tunnel 仍可能存在跨境链路延迟。这类延迟无法完全通过前端优化消除。

## 运维命令

查看 tennis 容器：

```bash
sg docker -c "docker ps --filter name=tennis-ranks"
```

查看日志：

```bash
sg docker -c "docker logs --tail=100 tennis-ranks"
```

重启容器：

```bash
sg docker -c "docker restart tennis-ranks"
```

查看 Cloudflare Tunnel 服务：

```bash
systemctl --user status cloudflared-tennis.service
```

重启 Cloudflare Tunnel：

```bash
systemctl --user restart cloudflared-tennis.service
```

手动备份数据库：

```bash
TENNIS_DB_FILE="$PWD/data/tennis.db" \
TENNIS_BACKUP_DIR="$PWD/data/backups" \
TENNIS_BACKUP_RETENTION_DAYS=30 \
node scripts/backup-db.mjs
```
