# Signal Web Bridge 跨平台可执行版本

该构建方式生成内置 Node.js 的 bridge 启动程序。宿主 Electron 只负责启动独立进程，不使用宿主 Electron 内置的 Node.js。

当前构建目标固定为：

- macOS Apple Silicon：`darwin-arm64`
- macOS Intel：`darwin-x64`
- Windows 64 位 Intel/AMD：`win32-x64`

## 构建环境

构建主机必须是 Apple Silicon Mac 或 Intel Mac，执行构建的 Node.js 必须与仓库 `package.json` 中 `engines.node` 完全一致。

```bash
pnpm install --frozen-lockfile
pnpm run web:build:server:executable
```

构建脚本会从 Node.js 官方发布目录下载三个 Node 运行时及 `SHASUMS256.txt`，逐个校验 SHA-256，然后注入同一个 SEA 服务入口。跨平台 SEA 的 `useCodeCache` 和 `useSnapshot` 均已关闭。

输出结构：

```text
server-executable-dist/
├─ BUILD_INFO.json
├─ README.md
├─ darwin-arm64/
│  ├─ signal-web-bridge
│  ├─ BUILD_INFO.json
│  └─ app/
├─ darwin-x64/
│  ├─ signal-web-bridge
│  ├─ BUILD_INFO.json
│  └─ app/
└─ win32-x64/
   ├─ signal-web-bridge.exe
   ├─ BUILD_INFO.json
   └─ app/
```

每个目标目录中的可执行文件和 `app` 必须保持同级关系。`app` 内只保留该目标对应的 `@signalapp/libsignal-client` 原生预编译文件。

## 命令行测试

Apple Silicon Mac：

```bash
SIGNAL_WEB_PROVISIONING_HOST=127.0.0.1 \
SIGNAL_WEB_PROVISIONING_PORT=0 \
./server-executable-dist/darwin-arm64/signal-web-bridge
```

Intel Mac：

```bash
SIGNAL_WEB_PROVISIONING_HOST=127.0.0.1 \
SIGNAL_WEB_PROVISIONING_PORT=0 \
./server-executable-dist/darwin-x64/signal-web-bridge
```

Windows PowerShell：

```powershell
$env:SIGNAL_WEB_PROVISIONING_HOST = "127.0.0.1"
$env:SIGNAL_WEB_PROVISIONING_PORT = "0"
.\server-executable-dist\win32-x64\signal-web-bridge.exe
```

启动成功后标准输出包含一行：

```text
SIGNAL_WEB_BRIDGE_READY {"type":"server-address","protocolVersion":1,"address":{"address":"127.0.0.1","family":"IPv4","port":动态端口},"service":{"name":"signal-desktop-web-bridge","version":"8.18.0"},"runtime":{"node":"24.15.0","platform":"当前平台","arch":"当前架构"},"pid":进程号}
```

## Electron 主进程启动示例

以下示例将三个目标目录一起放入宿主 Electron：

```text
process.resourcesPath/
└─ signal-web-bridge/
   ├─ darwin-arm64/
   ├─ darwin-x64/
   └─ win32-x64/
```

```js
const { spawn } = require('node:child_process');
const http = require('node:http');
const path = require('node:path');
const { app } = require('electron');

let bridgeProcess;

const executableNames = {
  'darwin-arm64': 'signal-web-bridge',
  'darwin-x64': 'signal-web-bridge',
  'win32-x64': 'signal-web-bridge.exe',
};

function waitForHealth(baseUrl, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;

  return new Promise((resolve, reject) => {
    function attempt() {
      const request = http.get(`${baseUrl}/health`, response => {
        response.resume();
        if (response.statusCode === 200) {
          resolve();
          return;
        }
        retry();
      });

      request.once('error', retry);
      request.setTimeout(1_000, () => request.destroy());
    }

    function retry() {
      if (Date.now() >= deadline) {
        reject(new Error('Signal Web bridge health check timed out'));
        return;
      }
      setTimeout(attempt, 100);
    }

    attempt();
  });
}

function startSignalWebBridge() {
  const targetId = `${process.platform}-${process.arch}`;
  const executableName = executableNames[targetId];
  if (typeof executableName !== 'string') {
    throw new Error(`Unsupported Signal Web bridge target: ${targetId}`);
  }

  const bridgeRoot = path.join(
    process.resourcesPath,
    'signal-web-bridge',
    targetId
  );
  const executablePath = path.join(bridgeRoot, executableName);

  return new Promise((resolve, reject) => {
    let settled = false;
    const child = spawn(executablePath, [], {
      cwd: bridgeRoot,
      env: {
        ...process.env,
        NODE_ENV: 'production',
        SIGNAL_WEB_PROVISIONING_HOST: '127.0.0.1',
        SIGNAL_WEB_PROVISIONING_PORT: '0',
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      windowsHide: true,
    });
    bridgeProcess = child;

    child.stdout.on('data', chunk => {
      console.log(`[signal-web-bridge] ${chunk.toString().trimEnd()}`);
    });
    child.stderr.on('data', chunk => {
      console.error(`[signal-web-bridge] ${chunk.toString().trimEnd()}`);
    });

    child.once('error', error => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    child.once('exit', (code, signal) => {
      bridgeProcess = undefined;
      if (!settled) {
        settled = true;
        reject(
          new Error(
            `Signal Web bridge exited before startup: code=${String(code)}, signal=${String(signal)}`
          )
        );
      }
    });

    child.on('message', async message => {
      if (
        settled ||
        typeof message !== 'object' ||
        message == null ||
        message.type !== 'server-address' ||
        typeof message.address !== 'object' ||
        message.address == null ||
        typeof message.address.port !== 'number'
      ) {
        return;
      }

      settled = true;
      const baseUrl = `http://127.0.0.1:${message.address.port}`;
      try {
        await waitForHealth(baseUrl);
        resolve({ baseUrl, child, address: message.address });
      } catch (error) {
        child.kill();
        reject(error);
      }
    });
  });
}

app.whenReady().then(async () => {
  const bridge = await startSignalWebBridge();
  console.log('Signal Web bridge ready:', bridge.baseUrl);
});

app.on('before-quit', () => {
  bridgeProcess?.kill();
});
```

IPC 消息结构固定为：

```json
{
  "type": "server-address",
  "protocolVersion": 1,
  "address": {
    "address": "127.0.0.1",
    "family": "IPv4",
    "port": 3100
  },
  "service": {
    "name": "signal-desktop-web-bridge",
    "version": "8.18.0"
  },
  "runtime": {
    "node": "24.15.0",
    "platform": "darwin",
    "arch": "arm64"
  },
  "pid": 12345
}
```

其中 `port` 是操作系统实际分配的端口，示例中的 `3100` 只用于说明字段类型。

## 宿主 Electron 打包要求

- 将 `server-executable-dist` 下的三个目标目录映射到 `process.resourcesPath/signal-web-bridge`。
- 如果安装包按平台分别构建，也可以只复制与安装包平台和架构完全一致的目标目录，但需要保留上述目录层级。
- 不要把可执行文件、`app/node_modules` 或其中的 `.node` 原生模块放进 ASAR。
- macOS 正式发布时，应由宿主应用的签名和公证流程重新签名对应的 bridge 可执行文件及原生模块。
- Windows 发布时，应使用宿主项目的代码签名证书签名 `signal-web-bridge.exe`。
- Electron 收到 IPC 地址后仍应请求 `/health`，确认服务可用后再加载业务页面。
