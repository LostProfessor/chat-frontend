# 聊天室 · 前端

基于 **Vue 3 + Vite** 的实时聊天前端。配套后端：[chat-backend](https://github.com/LostProfessor/chat-backend)。

支持群聊、私聊、好友管理、群组管理、管理后台，以及基于**自定义二进制分块协议**的
图片 / 视频 / 音频 / 任意文件传输（带实时进度、取消、断点续传）。

## 技术栈

| | |
|---|---|
| 框架 | Vue 3.5（Composition API + `<script setup>`） |
| 构建 | Vite 8 |
| 路由 | vue-router 4（含登录 / 管理员路由守卫） |
| HTTP | axios（请求拦截器自动附带 JWT，响应拦截器 401 自动续期并重放） |
| 图表 | chart.js + vue-chartjs（管理后台统计） |
| 图标 | [@icon-park/vue-next](https://github.com/bytedance/IconPark)（MIT） |

## 运行

```bash
npm install
npm run dev        # 开发服务器，默认 http://localhost:5173
npm run build      # 生产构建，输出到 dist/
npm run preview    # 预览生产构建
```

需要 Node `^20.19.0 || >=22.12.0`。

**必须先启动后端**（默认 `http://localhost:5258`），否则登录会失败。
后端需要先配置 user-secrets 才能启动，步骤见后端 README。

## 配置

后端地址写在环境变量里（`.env.development` / `.env.production`），改地址只需改这里：

```
VITE_API_BASE_URL=http://localhost:5258
```

WebSocket 地址目前在 `src/api/index.js` 的 `createWebSocket()` 里写死为
`ws://localhost:5259/ws?token=<JWT>`，部署到其他机器时需要一并修改。

> 开发服务器用 `vite --host` 启动，局域网内其他设备也能访问。
> 但此时后端的 CORS 白名单与 WebSocket 地址仍是 `localhost`，跨机访问需同步调整。

## 目录结构

```
src/
├── api/index.js           # 所有 HTTP 接口 + JWT 续期 + 鉴权探针
├── router/index.js        # 路由表与守卫（requiresAuth / requiresAdmin）
├── views/
│   ├── HomeView.vue       # 落地页
│   ├── LoginView.vue
│   ├── RegisterView.vue
│   ├── ChatView.vue       # 聊天主界面（消息渲染 + 文件传输状态机）
│   └── ManagementView.vue # 管理后台
├── components/icons/      # 图标统一出口
└── assets/                # 全局样式
```

## 几个实现要点

**文件传输**：不使用 `FormData` 上传。浏览器侧把文件切成 256 KB 分块，通过
WebSocket **二进制帧**发送（帧格式见后端 README），采用滑动窗口（8 块在途不等 ACK）
提升吞吐。关键约束是**必须串行「读一块 → 立刻发一块」** —— WebSocket 只保证
`send` 的调用顺序，并发读盘的 Promise 完成顺序不可控，会导致分块乱序、文件损坏
（症状很隐蔽：进度、字节数、落库全部正常，只有文件内容坏）。

**断线重连**：`ChatView.vue` 里采用指数退避（1s → 30s，不设次数上限）。
浏览器原生 `WebSocket` 在握手失败时**不暴露原因**（"后端没起来"和"token 无效"
拿到的都是 `onclose(code=1006, reason='')`），因此重试前会先发一个 HTTP 探针请求，
用状态码区分「鉴权失效」与「后端离线」—— 避免 token 失效时无限空转，
也避免后端一抖动就把用户误踢回登录页。

**消息撤回**：所有消息把后端的真实 `Message.id` 存在 `backendId` 字段，
`id` 是本地拼的 `senderId_timestamp`。匹配撤回通知必须用 `backendId`，用 `id` 永远匹配不上。

**图标**：全部从 `src/components/icons/index.js` 统一导出，
以后要整体更换图标库只需改这一个文件。

## 测试

两个脚本都**不依赖浏览器**，直接 `node` 运行。两者都需要后端已启动。

### 端到端冒烟测试 `ws-smoke-test.mjs`

```bash
node ws-smoke-test.mjs testfiles/压缩包.zip
```

HTTP 登录 → WS 握手 + JWT 鉴权 → 文本消息收发 → 文件传输 `Start`/`ACK` 分配会话
→ 分块上传至 `DONE` → 落盘文件字节一致性校验。共 6 项。

`testfiles/` 是测试素材目录（不入库），需自己准备一个文件。

### 帧层合规测试 `ws-frame-probe.mjs`

```bash
node ws-frame-probe.mjs
```

用裸 TCP 手工拼装各种**非法帧**，逐项断言服务端是否按 RFC 6455 拒绝，共 13 项：

| 用例 | 期望 |
|---|---|
| 正常 Ping / 正常文本消息 | 正常回 Pong / 广播回显 |
| 声明 payload 为 1 GB、4 GB（但一个字节都不发） | Close 1009 |
| 64 位长度字段最高位为 1 | Close 1002 |
| 未知 opcode `0x3`、保留控制帧 `0xB`、`Continuation(0x0)` | Close 1002 |
| 数据帧 `FIN=0`（分片） | Close 1002 |
| 客户端帧未加掩码 | Close 1002 |
| RSV1 置位（未协商扩展） | Close 1002 |
| 控制帧 payload > 125 字节 | Close 1002 |
| 正常 `Close(1000)` | 回应 Close 1000 并关闭 TCP |

> 为什么必须用裸 TCP：**浏览器的 WebSocket API 只允许发送合法帧**，
> 而这里要测的恰恰是非法输入，所以只能自己拼字节。

第 2 项（声明超大长度）是最关键的一条 —— 服务端的帧读取是「先分配缓冲区、再收数据」，
若不在分配之前校验长度，客户端只要发 10 个字节声明 1 GB，服务端就会立刻分配 1 GB，
10 个连接即可把进程打爆。

## 许可

学习项目。图标来自 IconPark（MIT），`chart.js` 为 MIT。
