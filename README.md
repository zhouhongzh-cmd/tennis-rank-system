# 网球积分系统

## 本地启动

```bash
npm install
export TENNIS_ADMIN_PASSWORD='你的录入密码'
npm start
```

然后打开：

```text
http://127.0.0.1:3000
```

## 公网部署

- 这个版本已经改成「前端 + Node 后端」。
- 公网访问时，排行榜和球员列表可直接看。
- 只有输入 `TENNIS_ADMIN_PASSWORD` 对应的密码后，才会解锁录入、删改比赛和球员维护。
- 数据默认保存在同目录下的 SQLite 文件 `tennis.db`，并会生成 `players`、`matches`、`player_ratings`、`rating_history` 四张表。
- 旧版的 `tennis-data.json` 只作为迁移兼容，不再是正式存储。

## Docker 部署

### 方式一：docker compose（推荐）

先修改 `docker-compose.yml` 里的密码：

```yaml
TENNIS_ADMIN_PASSWORD: "请改成强密码"
```

然后启动：

```bash
docker compose up -d --build
```

访问：

```text
http://服务器IP:3000
```

数据会保存在宿主机当前目录的 `data/tennis.db`，容器重启或重新构建后不会丢失。

常用命令：

```bash
docker compose logs -f
docker compose restart
docker compose down
```

### 方式二：docker run

```bash
docker build -t tennis-ranks .
mkdir -p data
docker run -d \
  --name tennis-ranks \
  --restart unless-stopped \
  -p 3000:3000 \
  -e TENNIS_ADMIN_PASSWORD='请改成强密码' \
  -e TENNIS_DB_FILE='/data/tennis.db' \
  -v "$PWD/data:/data" \
  tennis-ranks
```

### 反向代理建议

如果要绑定域名，建议在服务器前面放 Nginx / Caddy / 宝塔反向代理：

```text
域名 -> 服务器 3000 端口
```

正式公网使用时建议开启 HTTPS。密码不要写成默认值，也不要提交到公开仓库。

## 注意

- `TENNIS_ADMIN_PASSWORD` 不要留空。
- Docker 部署时建议挂载 `/data`，否则数据库会随着容器删除而丢失。
- 这是单进程轻量版，适合个人或小团队使用。
