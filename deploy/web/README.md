# Web 配置说明

本目录提供 Web 部署配置模板。模板不会被程序自动读取，需要在部署流程中复制到对应位置。

## 文件说明

- `env.development`：本地开发 bridge 环境变量。
- `env.production`：正式环境 bridge 环境变量。
- `runtime-config.development.js`：本地开发前端运行时配置。
- `runtime-config.production.js`：正式环境前端运行时配置。
- `signal-web-bridge.service`：systemd 服务模板。
- `nginx.production.conf`：Nginx 同域代理模板。

## 开发环境使用

```bash
cd /Users/apple/Documents/Signal-app/Signal-Desktop
cp deploy/web/runtime-config.development.js web/runtime-config.js
set -a
. deploy/web/env.development
set +a
pnpm run web:dev
```

开发环境默认地址：

- 页面：`http://127.0.0.1:3001`
- bridge：`http://127.0.0.1:3100`

## 正式环境使用

构建：

```bash
cd /opt/signal-web/Signal-Desktop
pnpm install --frozen-lockfile
pnpm run web:build
pnpm run web:build:server
cp deploy/web/runtime-config.production.js web-dist/runtime-config.js
```

上传静态页面和服务端产物：

```bash
rsync -av --delete web-dist/ /opt/signal-web/web-dist/
rsync -av --delete server-dist/ /opt/signal-web/server/
cd /opt/signal-web/server
pnpm install --prod
```

bridge 环境变量：

```bash
sudo mkdir -p /etc/signal-web
sudo cp deploy/web/env.production /etc/signal-web/bridge.env
sudo editor /etc/signal-web/bridge.env
```

systemd：

```bash
sudo cp deploy/web/signal-web-bridge.service /etc/systemd/system/signal-web-bridge.service
sudo systemctl daemon-reload
sudo systemctl enable --now signal-web-bridge
```

Nginx：

```bash
sudo cp deploy/web/nginx.production.conf /etc/nginx/conf.d/signal-web.conf
sudo editor /etc/nginx/conf.d/signal-web.conf
sudo nginx -t
sudo systemctl reload nginx
```

## 必改项

### `SIGNAL_WEB_ALLOWED_ORIGINS`

正式环境必须改为真实访问域名：

```bash
SIGNAL_WEB_ALLOWED_ORIGINS=https://signal.example.com
```

如果有多个入口，用英文逗号分隔。

### `server_name`

`nginx.production.conf` 中的域名必须改为真实域名：

```nginx
server_name signal.example.com;
```

### `root`

`nginx.production.conf` 中的静态目录必须指向部署后的 `web-dist`：

```nginx
root /opt/signal-web/web-dist;
```

### `WorkingDirectory`

`signal-web-bridge.service` 中的服务目录必须指向部署后的 `server-dist`：

```ini
WorkingDirectory=/opt/signal-web/server
```

### `SIGNAL_WEB_EMOJI_CACHE_DIR`

正式环境建议使用全局缓存目录：

```bash
SIGNAL_WEB_EMOJI_CACHE_DIR=/var/cache/signal-web/emoji
```

创建目录：

```bash
sudo mkdir -p /var/cache/signal-web/emoji
sudo chown -R <service-user>:<service-group> /var/cache/signal-web
```

## 变量说明

### `SIGNAL_WEB_PROVISIONING_HOST`

bridge 监听地址。正式环境建议绑定本机：

```bash
SIGNAL_WEB_PROVISIONING_HOST=127.0.0.1
```

### `SIGNAL_WEB_PROVISIONING_PORT`

bridge 监听端口：

```bash
SIGNAL_WEB_PROVISIONING_PORT=3100
```

### `SIGNAL_WEB_LINK_AND_SYNC`

是否启用扫码登录后的同步流程：

```bash
SIGNAL_WEB_LINK_AND_SYNC=1
```

### `SIGNAL_WEB_ALLOW_INSECURE_CDN_TLS`

是否跳过 CDN TLS 校验。正式环境必须为：

```bash
SIGNAL_WEB_ALLOW_INSECURE_CDN_TLS=0
```

### `SIGNAL_WEB_ALLOW_INSECURE_STORAGE_TLS`

是否跳过 Storage TLS 校验。正式环境必须为：

```bash
SIGNAL_WEB_ALLOW_INSECURE_STORAGE_TLS=0
```

### `SIGNAL_WEB_ATTACHMENT_TMP_MAX_AGE_MS`

附件临时工作目录清理时间，单位毫秒。默认示例为 24 小时：

```bash
SIGNAL_WEB_ATTACHMENT_TMP_MAX_AGE_MS=86400000
```

### `SIGNAL_WEB_SERVER_ENV`

服务环境开关。为空时使用默认生产配置；仅在需要连接 staging 时设置：

```bash
SIGNAL_WEB_SERVER_ENV=staging
```

### `SIGNAL_WEB_CDN_BASE_URL`

CDN 地址覆盖项。普通部署保持为空。

### `SIGNAL_WEB_UPSTREAM_API_BASE_URL`

上游 API 地址覆盖项。普通部署保持为空。

## 前端运行时配置说明

`runtime-config.js` 会被 `web/index.html` 和 `web-dist/index.html` 加载。

生产环境需要对 `runtime-config.js` 和 `index.html` 禁用缓存。示例
`nginx.production.conf` 已经为这两个文件设置了 `Cache-Control: no-store`；
如果前面还有 CDN，也要在 CDN 上对 `/runtime-config.js` 关闭缓存或主动刷新。

开发环境：

```js
apiBaseUrl: "http://127.0.0.1:3100"
```

正式同域部署：

```js
apiBaseUrl: ""
```

正式同域部署时，浏览器会请求当前域名下的 `/messages/*`、`/provisioning/*` 等接口，由反向代理转发给 bridge，因此没有端口跨域问题。
