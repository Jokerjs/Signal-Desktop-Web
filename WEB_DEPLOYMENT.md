# Signal Web 部署说明

本文档描述当前 Web 版本的正式部署流程。Web 版本由两部分组成：

- 静态前端：`web-dist`
- Node bridge 服务：`server-dist`

`pnpm run generate` 是桌面端 Electron 打包链路，最终运行 `bundles/main.js`，不是 Web 正式部署入口。Web 正式构建使用 `pnpm run web:build`。

Node bridge 的正式服务端产物使用 `pnpm run web:build:server` 生成。部署服务器不需要放完整源码目录。

## 1. 环境要求

- Node.js：建议使用项目要求的 Node 版本，例如 `24.15.0`
- pnpm：仓库锁定版本为 `11.5.2`
- HTTPS 域名
- 反向代理：Nginx、Caddy 或同等组件
- bridge 服务进程管理：systemd、PM2、Docker、Kubernetes 均可

配置模板位于：

```text
deploy/web/
```

其中包含开发环境、正式环境、Nginx 和 systemd 示例配置。

## 2. 构建前端

```bash
cd /opt/signal-web/Signal-Desktop
pnpm install --frozen-lockfile
pnpm run web:build
```

构建产物目录：

```text
web-dist/
```

部署时将 `web-dist` 作为静态站点目录。

## 3. 构建 Node Bridge 服务端产物

在构建机执行：

```bash
cd /opt/signal-web/Signal-Desktop
pnpm install --frozen-lockfile
pnpm run web:build:server
```

构建产物目录：

```text
server-dist/
```

`server-dist` 内包含：

```text
server-dist/
├─ package.json
├─ README.md
├─ config/production.json
├─ build/jumbomoji.json
├─ build/optional-resources.json
├─ deploy/web/env.production
└─ ts/web/provisioning/WebProvisioningBridge.node.mjs
```

把 `server-dist` 上传到服务器，例如：

```bash
rsync -av --delete server-dist/ signal-web@signal.example.com:/opt/signal-web/server/
```

在服务器安装运行依赖：

```bash
cd /opt/signal-web/server
corepack enable
pnpm install --prod
```

启动命令：

```bash
cd /opt/signal-web/server
pnpm start
```

## 4. 启动 Node Bridge

开发环境可以使用：

```bash
pnpm run web:bridge
```

生产环境建议由进程管理器托管，启动命令等价于：

```bash
cd /opt/signal-web/server
pnpm start
```

建议生产环境变量：

```bash
NODE_ENV=production
SIGNAL_WEB_PROVISIONING_HOST=127.0.0.1
SIGNAL_WEB_PROVISIONING_PORT=3100
SIGNAL_WEB_ALLOWED_ORIGINS=https://signal.example.com
SIGNAL_WEB_ALLOW_INSECURE_CDN_TLS=0
SIGNAL_WEB_ALLOW_INSECURE_STORAGE_TLS=0
SIGNAL_WEB_EMOJI_CACHE_DIR=/var/cache/signal-web/emoji
SIGNAL_WEB_EMOJI_MEMORY_CACHE_MAX_SHEETS=16
SIGNAL_WEB_ATTACHMENT_TMP_MAX_AGE_MS=86400000
```

可以直接基于模板修改：

```bash
sudo mkdir -p /etc/signal-web
sudo cp deploy/web/env.production /etc/signal-web/bridge.env
sudo editor /etc/signal-web/bridge.env
```

可选变量：

```bash
SIGNAL_WEB_SERVER_ENV=staging
SIGNAL_WEB_CDN_BASE_URL=
SIGNAL_WEB_UPSTREAM_API_BASE_URL=
```

不要在正式环境使用宽松 CORS。`SIGNAL_WEB_ALLOWED_ORIGINS` 必须写实际前端域名。

## 5. systemd 示例

```ini
[Unit]
Description=Signal Web Bridge
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/signal-web/server
Environment=NODE_ENV=production
Environment=SIGNAL_WEB_PROVISIONING_HOST=127.0.0.1
Environment=SIGNAL_WEB_PROVISIONING_PORT=3100
Environment=SIGNAL_WEB_ALLOWED_ORIGINS=https://signal.example.com
Environment=SIGNAL_WEB_ALLOW_INSECURE_CDN_TLS=0
Environment=SIGNAL_WEB_ALLOW_INSECURE_STORAGE_TLS=0
Environment=SIGNAL_WEB_EMOJI_CACHE_DIR=/var/cache/signal-web/emoji
ExecStart=/usr/bin/env pnpm start
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

启动：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now signal-web-bridge
sudo systemctl status signal-web-bridge
```

健康检查：

```bash
curl http://127.0.0.1:3100/health
```

## 6. Nginx 示例

```nginx
server {
  listen 443 ssl http2;
  server_name signal.example.com;

  root /opt/signal-web/web-dist;
  index index.html;

  client_max_body_size 200m;

  location / {
    try_files $uri $uri/ /index.html;
  }

  location /messages/stream {
    proxy_pass http://127.0.0.1:3100;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_buffering off;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
  }

  location ~ ^/(health|provisioning|messages|contacts|groups|profile|username|emoji)/ {
    proxy_pass http://127.0.0.1:3100;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 300s;
    proxy_send_timeout 300s;
  }
}
```

`/messages/stream` 是长连接接口，必须关闭代理缓冲并放宽超时时间。

## 7. 多用户部署注意事项

当前 Web 版本不是纯静态应用。浏览器负责保存用户侧状态，Node bridge 负责扫码登录、消息流、附件上传下载、Signal 协议相关操作。

关键点：

- 浏览器数据存储在 IndexedDB，数据库名为 `renderPersistence`。
- bridge 运行态会保存当前消息流会话。
- 如果部署多个 bridge 实例，需要让同一浏览器会话固定到同一个实例。
- 不建议让多个 bridge 实例随意负载均衡同一个用户请求，否则可能出现 `Message runtime session not found`、消息流断开、附件下载失败等问题。
- 生产环境不要把用户协议状态、聊天记录或附件明文写入共享服务端目录。

当前已知服务端目录用途：

- `SIGNAL_WEB_EMOJI_CACHE_DIR`：emoji 图片缓存，可配置为全局缓存目录。
- `.signal-web/attachments/tmp`：附件临时工作目录，受 `SIGNAL_WEB_ATTACHMENT_TMP_MAX_AGE_MS` 控制。

附件上传流程应保持流式处理到 Signal CDN，不应长期保存到业务服务器。

## 8. 日志

正式部署不要依赖 `web-bridge.log` 或 `web-dev.log` 文件。它们不是 `web:build` 的产物，更适合作为本地调试重定向文件。

生产环境建议：

- bridge 输出到 stdout/stderr
- 由 systemd、Docker、Kubernetes 或日志系统接管
- 配置日志轮转和保留周期
- 禁止把敏感认证信息、profile key、协议密钥写入长期日志

systemd 查看日志：

```bash
journalctl -u signal-web-bridge -f
```

## 9. 发布流程

推荐使用 release 目录加软链接，便于回滚：

```bash
mkdir -p /opt/signal-web/releases
cd /opt/signal-web/releases
git clone <repo-url> signal-web-20260702
cd signal-web-20260702
pnpm install --frozen-lockfile
pnpm run web:build
pnpm run web:build:server

rsync -av --delete web-dist/ /opt/signal-web/web-dist/
rsync -av --delete server-dist/ /opt/signal-web/server/
cd /opt/signal-web/server
pnpm install --prod
sudo systemctl restart signal-web-bridge
sudo nginx -t
sudo systemctl reload nginx
```

回滚时恢复上一版 `web-dist` 和 `server-dist`，然后重启 bridge 并 reload Nginx。

## 9. 上线检查

上线后按顺序验证：

1. 打开 `https://signal.example.com`
2. 显示二维码登录页
3. 手机扫码并完成同步
4. `/messages/stream` 返回 `transport-status: open`
5. 会话列表、联系人、群组显示正常
6. 文本消息收发正常
7. 图片、语音、视频、文件消息收发正常
8. 附件重新下载正常
9. 刷新页面后仍保持登录状态
10. 设置页、个人资料、用户名、群组详情可正常打开

## 10. 常见问题

### CORS 报错

检查：

```bash
SIGNAL_WEB_ALLOWED_ORIGINS=https://signal.example.com
```

前端域名必须和实际访问域名完全一致。

### `/messages/stream` 断开或一直连接中

检查反向代理：

- `/messages/stream` 是否关闭 `proxy_buffering`
- `proxy_read_timeout` 是否过短
- bridge 是否仍在运行
- 浏览器请求是否被分发到另一个 bridge 实例

### `Message runtime session not found`

通常表示浏览器请求没有打到持有该消息运行态的 bridge 实例。单实例部署不会有这个问题；多实例部署需要会话固定。

### TLS 证书错误

正式环境应修复系统 CA 或服务端证书链，不建议开启不安全 TLS。

生产环境应保持：

```bash
SIGNAL_WEB_ALLOW_INSECURE_CDN_TLS=0
SIGNAL_WEB_ALLOW_INSECURE_STORAGE_TLS=0
```

### 附件上传失败

检查：

- Nginx `client_max_body_size`
- `/messages/attachment/upload` 是否代理到 bridge
- bridge 日志里的 Signal CDN 上传错误
- 当前用户是否存在有效消息流会话
