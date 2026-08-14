# DSH 内网访问网关（dsh-lan-gate）

让同一局域网内的手机、平板、其他电脑通过网页访问本机 [DeepSeek Harness](https://github.com/deepseek-ai/DeepSeek-Harness)（DSH），并且**首次访问需要本机批准**。

一个自包含的单文件插件（`lan-gate.mjs`），进程内反向代理 + 首页注入，无外部依赖、无子进程。

## 功能特性

- **内网访问**：插件在本机启动反向代理 `0.0.0.0:3088 → 127.0.0.1:3080`，局域网内设备打开 `http://<电脑IP>:3088` 即可使用 DSH 网页
- **首次访问批准**：新设备第一次访问会看到「等待本机批准」页面，本机在 DSH 的 **设置 → 内网访问** 面板中允许后，该设备自动进入 DSH；拒绝则看到拒绝页
- **每台设备指定访问方式**：
  - 自动 —— 按屏幕宽度适配
  - 手机 —— 强制紧凑手机排版（更小字号、更紧间距、全宽消息区、防 iOS 聚焦放大）
  - 电脑 —— 即使窗口很窄也保持桌面排版
- **手机端完整适配**：等待/拒绝门禁页移动端设计、设置面板全屏化、模型选择与上下文弹层防遮挡、`crypto.randomUUID` polyfill（内网 HTTP 非安全上下文兼容）
- **本机管理面板**：注入到 DSH 设置界面（设置 → 内网访问），支持状态查看、启停、批准/拒绝、切换访问方式、撤销、复制访问地址
- **状态持久化**：批准记录保存在 `$DSH_HOME/lan-gate-state.json`，重启 DSH 后依然有效
- **安全边界**：管理接口（`/lan-gate/status`、`/lan-gate/action`）仅放行本机请求（校验 `x-forwarded-for`）；代理转发时重写 Host 为回环地址并通过 DSH 的信任栅栏；撤销设备后其已建立的连接会在数秒内被强制断开
- **设备令牌 + Cookie 绑定**：每次批准会生成随机令牌（32 位十六进制），设备通过一次性认领链接换取 `lg_token` Cookie（HttpOnly + SameSite），后续请求必须携带匹配的 Cookie 才能转发；令牌只发放给第一个认领的浏览器，其他浏览器（或 Cookie 被清掉的同设备）会看到「已绑定到其他浏览器」页，需撤销后重新批准
- **请求限流**：每个来源 IP 每分钟最多 `120` 个请求（滑动窗口），超限返回 `429`（含 `Retry-After`），防止内网扫描与暴力尝试
- **监听地址可配**：默认 `0.0.0.0`（全局域网可达）；放在前置反向代理/隧道后面时可收紧为 `127.0.0.1`，只让本机代理接入

## 架构

```
局域网设备 ──HTTP──▶ 0.0.0.0:3088（本插件进程内代理）
                         │ 未批准 → 门禁页 / 拒绝页
                         │ 已批准但无有效 Cookie → 一次性认领链接（换取 lg_token Cookie）
                         │ 已批准且 Cookie 匹配 → 转发（Host 重写 + WebSocket 升级转发）
                         ▼
                  127.0.0.1:3080（DSH Web 服务）
```

插件同时通过 `webServer.tapIndex` 向首页注入：`crypto.randomUUID` polyfill、设备排版 CSS、以及设置界面内的管理面板（原生 JS 实现，仅本机可见）。

## 安装（跟着做，三步完成）

### 第 1 步：把插件文件放到 DSH 数据目录

DSH 的数据目录（DSH_HOME）里存放着你的配置，插件就放这里。先确认它在哪：

**Windows（PowerShell）**，复制执行：

```powershell
echo $env:DSH_HOME
# 如果上面输出为空，则默认在：C:\Users\你的用户名\.dsh
```

**macOS / Linux（终端）**，复制执行：

```bash
echo "${DSH_HOME:-$HOME/.dsh}"
```

确认目录后，把插件放进去：

**Windows（PowerShell）**（把下面第一行换成你实际的 DSH 数据目录）：

```powershell
$dsh = "D:\deepseek-harness-master\.dsh"
New-Item -ItemType Directory -Force -Path "$dsh\lan-gate" | Out-Null
Copy-Item ".\lan-gate.mjs" "$dsh\lan-gate\lan-gate.mjs" -Force
```

**macOS / Linux**：

```bash
DSH_DIR="${DSH_HOME:-$HOME/.dsh}"
mkdir -p "$DSH_DIR/lan-gate"
cp ./lan-gate.mjs "$DSH_DIR/lan-gate/lan-gate.mjs"
```

执行完，你应该能看到这个文件：`<DSH数据目录>\lan-gate\lan-gate.mjs`

### 第 2 步：注册插件（改一行配置文件）

打开文件：`<DSH数据目录>\profiles\web\cordis.patch.yml`

- 如果文件不存在，就新建一个；
- 如果文件里是 `[]`（空配置），把 `[]` 整个替换成下面内容；
- 如果文件里已经有内容，把下面这段**追加**到末尾。

```yaml
- insert:
    - id: lan-gate
      name: 'file:///D:/deepseek-harness-master/.dsh/lan-gate/lan-gate.mjs'
```

**把 `name:` 里的路径换成你第 1 步实际放置的完整路径**，规则如下：

| 系统 | 写法 | 例子 |
|---|---|---|
| Windows | `file:///盘符:/完整路径` | `file:///D:/deepseek-harness-master/.dsh/lan-gate/lan-gate.mjs` |
| macOS / Linux | `file:///完整路径` | `file:///home/me/.dsh/lan-gate/lan-gate.mjs` |

> ⚠️ **最容易踩的坑（Windows）**：必须写 `file:///D:/...`，不能写 `D:/...`。DSH 的插件加载器不会自动把 Windows 路径转成 URL，裸写会报错 `ERR_UNSUPPORTED_ESM_URL_SCHEME`。

改完保存即可，不用改任何源码。

### 第 3 步：重启 DSH 并验证

1. **完全退出**正在运行的 DSH（终端里 Ctrl+C 结束），再重新启动：

   ```bash
   pnpm dsh web        # 从源码运行时
   # 或你平时启动 DSH 的命令
   ```

2. **验证插件已加载**（二选一）：
   - 浏览器打开 `http://127.0.0.1:3080/lan-gate/status`，看到类似
     `{"state":"running","port":3088,...}` 就成功了；
   - 或者打开 DSH 网页 → 左下角齿轮进入**设置**，左侧导航出现「🌐 内网访问」。

3. 之后的日常使用见下方「使用」。

### 常见问题（按症状查）

| 现象 | 原因与解决 |
|---|---|
| 启动时报 `ERR_UNSUPPORTED_ESM_URL_SCHEME` | 第 2 步的路径没写成 `file:///` 形式，改过来再重启 |
| `/lan-gate/status` 打不开或 404 | 插件没加载成功，检查第 2 步配置，重启后看启动日志 |
| 面板显示「出错：EADDRINUSE」 | 3088 端口被占用：打开 `lan-gate.mjs`，把顶部 `PROXY_PORT = 3088` 改成其它端口（如 `3089`），重启 DSH |
| 手机打不开 `http://<电脑IP>:3088` | ① 确认手机和电脑在同一网络；② 系统防火墙放行：Windows 管理员 PowerShell 执行 `netsh advfirewall firewall add rule name="DSH LAN" dir=in action=allow protocol=TCP localport=3088` |
| 设置里看不到「内网访问」 | 面板只在本机显示，内网设备看不到是正常的；本机看不到说明插件未加载（回第 3 步验证） |
| 重启后手机又要重新批准 | 批准记录在 `<DSH数据目录>\lan-gate-state.json`，文件被删除或 DSH_HOME 变了才会丢；从旧版（临时插件）升级的用户需重新批准一次 |
| 手机显示「已绑定到其他浏览器」 | 该设备的令牌已发放给另一个浏览器（例如换浏览器、清了 Cookie、或同 IP 的别的设备抢先认领了）。在本机面板撤销该设备再重新批准，手机会自动重新认领 |
| 页面出现 429（请求过于频繁） | 该 IP 超过每分钟 120 个请求上限，等一分钟自动恢复；正常使用不会触发（网页应用远比这个频率低） |
| 用反向代理/隧道转发到本插件时全部被拒 | 前置代理过来的请求源 IP 不是本机局域网地址，需要在**前置代理**上配置登录认证后放行；然后把 `LISTEN_HOST` 改为 `127.0.0.1` 只让本机代理接入 |

## 使用

1. 打开 DSH 设置（左下角齿轮）→ **内网访问**：面板显示运行状态与全部访问地址（点击可复制）
2. 把地址发给手机（微信/QQ 发给自己即可），手机浏览器打开
3. 手机显示「等待本机批准」，本机面板的**待批准设备**里选择 自动/手机/电脑 → 点**允许**，手机自动进入 DSH
4. 随时在面板中切换每台设备的访问方式、撤销、或停止服务

## 配置

插件顶部常量可按需修改（改完重启 DSH），也可以用环境变量覆盖（**推荐**，改文件升级时不易丢）：

| 常量 | 默认值 | 环境变量 | 说明 |
|---|---|---|---|
| `PROXY_PORT` | `3088` | `LAN_GATE_PORT` | 内网访问端口 |
| `LISTEN_HOST` | `0.0.0.0` | `LAN_GATE_HOST` | 监听地址；放在前置代理/隧道后建议改为 `127.0.0.1` |
| `RATE_LIMIT_PER_MIN` | `120` | — | 每 IP 每分钟请求上限，超限返回 429 |
| `TARGET_HOST` | `127.0.0.1` | — | DSH 服务地址 |
| `TARGET_PORT` | `3080` | — | DSH 服务端口 |

## 卸载

删除 `cordis.patch.yml` 中的 lan-gate 行（或整段 `- insert:`），重启 DSH。批准记录如需清除，删除 `$DSH_HOME/lan-gate-state.json`。

## 安全提示

- 本插件是**内网转发**：传输没有加密，请只在可信的局域网内使用，**不要把 `3088` 端口直接暴露到公网**（端口映射到公网 = 裸奔）
- **要上外网（WAN）必须先加 HTTPS + 登录认证**，推荐方案（二选一）：
  - **Cloudflare Tunnel + Cloudflare Access**（免费，不需要公网 IP）：Access 的登录与 MFA 挡在所有流量前面，再到本插件
  - **Caddy（自动 HTTPS）+ Authelia / basic_auth**：有公网 IP/域名时的自托管方案
  - 用了前置代理后，把 `LISTEN_HOST` 改成 `127.0.0.1`（或设 `LAN_GATE_HOST=127.0.0.1`），只让本机代理接入
- 本插件的自带防线（v1.1）：每 IP 限流、设备令牌 + Cookie 绑定、管理接口仅本机、撤销即断开
- **已知限制（请了解）**：令牌绑定按 IP + Cookie 实现，同一个 IP 后面的多个设备（例如同一 NAT / 同一路由后的多台手机）共享一次批准；极端情况下同 IP 的攻击者理论上可在认领瞬间抢先换取 Cookie。真正的多设备/多用户隔离，请用上面推荐的「前置代理 + 登录认证」方案
- 撤销 = 立即断开对应设备（含已建立的连接），且撤销后重新批准会签发全新令牌，旧 Cookie 立即失效

## 兼容性

- DeepSeek Harness（run-from-source 的 web profile）
- Node ≥ 18（仅使用内置模块）
- 现代浏览器（Chrome / Safari / Firefox / 微信内置浏览器）

## License

[MIT](LICENSE)
