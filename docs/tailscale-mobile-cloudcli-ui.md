# 用 Tailscale 从手机访问电脑上的 CloudCLI UI

本文说明如何在电脑上启动 CloudCLI UI，并通过 Tailscale 从手机浏览器访问它。

适用场景：

- 电脑在家里、办公室或内网中，不想配置公网 IP、端口转发或反向代理。
- 手机和电脑都登录同一个 Tailscale tailnet。
- 只希望自己或 tailnet 内授权设备访问 CloudCLI UI。

## 前提条件

1. 电脑已安装 Node.js 22 或更高版本。
2. 电脑和手机都已安装 Tailscale，并登录同一个账号或同一个 tailnet。
3. 手机上的 Tailscale 处于连接状态。
4. 电脑上可以正常启动 CloudCLI UI。

Tailscale 安装入口：

- 官方安装文档：https://tailscale.com/docs/install
- macOS 安装文档：https://tailscale.com/kb/1016/install-mac

## 方案 A：直接用 Tailscale IP 访问

这是最直接的方式。

### 1. 在电脑上启动 CloudCLI UI

在电脑终端运行：

```bash
npx @cloudcli-ai/cloudcli
```

或如果已经全局安装：

```bash
cloudcli
```

默认访问地址是：

```text
http://localhost:3001
```

CloudCLI UI 默认监听 `0.0.0.0:3001`，因此同一网络或 Tailscale 网络内的设备可以通过电脑地址访问。

如果要指定端口：

```bash
cloudcli start --port 3001
```

### 2. 查看电脑的 Tailscale IP

在电脑上运行：

```bash
tailscale ip -4
```

输出通常类似：

```text
100.64.12.34
```

### 3. 从手机访问

确认手机 Tailscale 已连接，然后在手机浏览器打开：

```text
http://100.64.12.34:3001
```

把 `100.64.12.34` 换成你电脑实际的 Tailscale IP。

首次打开 CloudCLI UI 时，按页面提示设置访问密码。

## 方案 B：用 MagicDNS 名称访问

如果你的 tailnet 开启了 MagicDNS，可以不用记 IP，直接用电脑名称访问。

Tailscale 官方说明：MagicDNS 会为 tailnet 中的设备生成 DNS 名称，设备之间可以用机器名互相访问。

文档：https://tailscale.com/docs/features/magicdns

### 1. 确认电脑名称

在 Tailscale 管理后台或电脑的 Tailscale 菜单中查看设备名称，例如：

```text
macbook-pro
```

### 2. 从手机访问

手机连接 Tailscale 后，在浏览器打开：

```text
http://macbook-pro:3001
```

如果短名称不可用，使用完整 MagicDNS 名称：

```text
http://macbook-pro.your-tailnet.ts.net:3001
```

把 `macbook-pro.your-tailnet.ts.net` 换成你自己的设备完整域名。

## 启动 Codex sandbox，而不是默认 Claude Code

如果你使用 Docker Sandbox 模式，CloudCLI 默认启动 Claude Code。要启动 Codex，需要显式传 `--agent codex`。

先保存 OpenAI 凭据：

```bash
sbx secret set -g openai
```

然后启动 Codex sandbox：

```bash
npx @cloudcli-ai/cloudcli@latest sandbox ~/my-project --agent codex
```

启动后，手机访问方式仍然一样：

```text
http://<电脑的Tailscale-IP>:3001
```

或：

```text
http://<电脑的MagicDNS名称>:3001
```

## 不建议使用 Tailscale Funnel

手机已经登录 Tailscale 时，不需要使用 Tailscale Funnel。

推荐使用普通 Tailscale 私网访问：

```text
手机 Tailscale -> 电脑 Tailscale IP 或 MagicDNS -> CloudCLI UI:3001
```

原因：

- 服务只暴露给 tailnet 内授权设备。
- 不需要公网入口。
- 不需要 HTTPS 证书或 Funnel 配置。
- 风险面更小。

Tailscale Funnel 适合把本地服务公开给没有登录 tailnet 的公网用户。CloudCLI UI 通常不应该这样暴露。

官方说明：

- Tailscale Serve：https://tailscale.com/docs/features/tailscale-serve
- Tailscale Funnel：https://tailscale.com/docs/features/tailscale-funnel

## 常见问题

### 手机打不开页面

按顺序检查：

1. 电脑上的 CloudCLI UI 是否正在运行。
2. 电脑本机能否打开 `http://localhost:3001`。
3. 手机 Tailscale 是否已连接。
4. 手机和电脑是否在同一个 tailnet。
5. 手机浏览器访问的是否是 `http://<Tailscale-IP>:3001`，不是 `https://`。
6. 电脑防火墙是否阻止了入站连接。

### 端口不是 3001

如果启动时指定了其他端口，例如：

```bash
cloudcli start --port 8080
```

手机也要访问对应端口：

```text
http://<电脑的Tailscale-IP>:8080
```

### MagicDNS 名称打不开

先改用 Tailscale IP 验证：

```text
http://<电脑的Tailscale-IP>:3001
```

如果 IP 可用但名称不可用，检查：

1. Tailscale 管理后台是否启用了 MagicDNS。
2. 手机是否正在使用 Tailscale DNS。
3. 是否需要使用完整名称，例如 `device-name.tailnet-name.ts.net`。

### 只想允许自己手机访问

这属于 Tailscale ACL 策略配置。可以在 Tailscale 管理后台限制哪些用户或设备能访问电脑的 `3001` 端口。

## 最小命令清单

电脑上：

```bash
npx @cloudcli-ai/cloudcli
tailscale ip -4
```

手机上：

```text
打开 Tailscale
打开浏览器
访问 http://<电脑的Tailscale-IP>:3001
```
