// 帧层加固验证：用裸 TCP 手搓各种非法帧，逐项断言服务器是否按 RFC 6455 拒绝。
//
// 用法: node ws-frame-probe.mjs
// 前提: 后端已在 5258/5259 运行
//
// 为什么不用浏览器的 WebSocket API：浏览器只允许发合法的帧，
// 而我们要测的恰恰是「非法输入」，所以必须自己拼字节。

import net from 'node:net'
import crypto from 'node:crypto'

const API = 'http://localhost:5258'
const WS_PORT = 5259
const SETTLE_MS = 1200

// ─────────────────────────── 工具 ───────────────────────────

async function login() {
  const r = await fetch(`${API}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nickname: '测试用户C', email: 'testC@chat.com', password: 'password123' })
  })
  if (r.status !== 200) throw new Error(`登录失败: ${r.status}`)
  return (await r.json()).token
}

function handshakeRequest(token) {
  const wsKey = crypto.randomBytes(16).toString('base64')
  return [
    `GET /ws?token=${encodeURIComponent(token)} HTTP/1.1`,
    `Host: localhost:${WS_PORT}`,
    `Connection: Upgrade`,
    `Upgrade: websocket`,
    `Sec-WebSocket-Version: 13`,
    `Sec-WebSocket-Key: ${wsKey}`,
    `Origin: http://localhost:5173`,
  ].join('\r\n') + '\r\n\r\n'
}

/**
 * 手工构造一个客户端帧。
 * forceLen 可以「声明」一个与实际 payload 不符的长度 —— 这正是我们
 * 要用来复现「声明 1 GB 却不发数据」「声明 4 GB 触发 int 环绕」的手法。
 */
function clientFrame({ opcode = 0x1, fin = true, rsv = 0, masked = true, payload = Buffer.alloc(0), forceLen = null }) {
  const b0 = (fin ? 0x80 : 0x00) | (rsv << 4) | opcode
  const len = forceLen === null ? payload.length : forceLen
  const parts = [Buffer.from([b0])]

  if (len < 126) {
    parts.push(Buffer.from([(masked ? 0x80 : 0x00) | len]))
  } else if (len <= 0xffff) {
    const h = Buffer.alloc(3)
    h[0] = (masked ? 0x80 : 0x00) | 126
    h.writeUInt16BE(len, 1)
    parts.push(h)
  } else {
    const h = Buffer.alloc(9)
    h[0] = (masked ? 0x80 : 0x00) | 127
    h.writeBigUInt64BE(BigInt(len), 1)
    parts.push(h)
  }

  if (masked) {
    const key = crypto.randomBytes(4)
    parts.push(key)
    const m = Buffer.from(payload)
    for (let i = 0; i < m.length; i++) m[i] ^= key[i % 4]
    parts.push(m)
  } else {
    parts.push(payload)
  }
  return Buffer.concat(parts)
}

/** 解析服务端发来的帧（服务端帧不掩码） */
function parseServerFrames(buf) {
  const frames = []
  let i = 0
  while (i + 2 <= buf.length) {
    const opcode = buf[i] & 0x0f
    let len = buf[i + 1] & 0x7f
    let off = i + 2
    if (len === 126) {
      if (off + 2 > buf.length) break
      len = buf.readUInt16BE(off); off += 2
    } else if (len === 127) {
      if (off + 8 > buf.length) break
      len = Number(buf.readBigUInt64BE(off)); off += 8
    }
    if (off + len > buf.length) break
    frames.push({ opcode, payload: buf.subarray(off, off + len) })
    i = off + len
  }
  return frames
}

/** 建一条连接、握手、发帧、收集服务端回应 */
function probe(token, framesToSend, { settleMs = SETTLE_MS } = {}) {
  return new Promise((resolve) => {
    const sock = net.connect(WS_PORT, '127.0.0.1')
    let buf = Buffer.alloc(0)
    let handshakeDone = false
    let tcpClosed = false
    let closeAt = null
    const t0 = Date.now()

    sock.on('connect', () => sock.write(handshakeRequest(token)))

    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d])
      if (!handshakeDone) {
        const idx = buf.indexOf('\r\n\r\n')
        if (idx >= 0) {
          handshakeDone = true
          buf = buf.subarray(idx + 4)          // 丢掉握手响应，剩下的才是帧
          for (const f of framesToSend) sock.write(f)
        }
      }
    })

    sock.on('close', () => { tcpClosed = true; closeAt = Date.now() - t0 })
    sock.on('error', () => {})

    setTimeout(() => {
      sock.destroy()
      const frames = parseServerFrames(buf)
      const closeFrame = frames.find((f) => f.opcode === 0x8)
      const closeCode = closeFrame && closeFrame.payload.length >= 2
        ? closeFrame.payload.readUInt16BE(0) : null
      const closeReason = closeFrame && closeFrame.payload.length > 2
        ? closeFrame.payload.subarray(2).toString('utf8') : ''
      resolve({
        opcodes: frames.map((f) => '0x' + f.opcode.toString(16)),
        texts: frames.filter((f) => f.opcode === 0x1).map((f) => f.payload.toString('utf8')),
        closeCode,
        closeReason,
        tcpClosed,
        closeAt,
      })
    }, settleMs)
  })
}

// ─────────────────────────── 用例 ───────────────────────────

const results = []
function check(label, ok, detail) {
  results.push({ label, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  -> ${detail}`)
}

const token = await login()
console.log(`已登录，token 长度 ${token.length}\n`)

const TLS = (obj) => JSON.stringify({ type: 'group', groupId: 'public', content: obj })

// 1. 正常 Ping → 必须回 Pong（帧层 happy path，不依赖业务逻辑）
{
  const r = await probe(token, [clientFrame({ opcode: 0x9, payload: Buffer.from('ping-你好') })])
  const pong = r.opcodes.includes('0xa')
  check('正常 Ping 回 Pong', pong && r.closeCode === null,
    `服务端帧=${JSON.stringify(r.opcodes)} closeCode=${r.closeCode}`)
}

// 2. 正常文本消息 → 应收到广播回显
{
  const marker = '帧层探针-' + Date.now()
  const r = await probe(token, [clientFrame({ opcode: 0x1, payload: Buffer.from(TLS(marker)) })])
  check('正常文本消息可收发', r.opcodes.includes('0x1') && r.closeCode === null,
    `服务端帧=${JSON.stringify(r.opcodes)} closeCode=${r.closeCode}`)
}

// 3. ★ 声明 1 GB 长度但不发数据 —— 必须被拒，且不能真的分配 1 GB
{
  const r = await probe(token, [clientFrame({ opcode: 0x1, forceLen: 1000000000, payload: Buffer.alloc(0) })])
  check('声明 1 GB 长度被拒（1009）', r.closeCode === 1009,
    `closeCode=${r.closeCode} reason="${r.closeReason}"`)
}

// 4. ★ 声明 4 GB（旧版 (int) 强转会环绕成 0，静默成功并让流错位）
{
  const r = await probe(token, [clientFrame({ opcode: 0x1, forceLen: 0x100000000, payload: Buffer.alloc(0) })])
  check('声明 4 GB（int 环绕）被拒（1009）', r.closeCode === 1009,
    `closeCode=${r.closeCode} reason="${r.closeReason}"`)
}

// 5. 64 位长度最高位为 1（RFC 禁止）
{
  const r = await probe(token, [clientFrame({ opcode: 0x1, forceLen: 0x8000000000000000n, payload: Buffer.alloc(0) })])
  check('64 位长度最高位为 1 被拒（1002）', r.closeCode === 1002,
    `closeCode=${r.closeCode} reason="${r.closeReason}"`)
}

// 6. 未知 opcode 0x3（保留的非控制帧）
{
  const r = await probe(token, [clientFrame({ opcode: 0x3 })])
  check('未知 opcode 0x3 被拒（1002）', r.closeCode === 1002,
    `closeCode=${r.closeCode} reason="${r.closeReason}"`)
}

// 7. 保留控制帧 opcode 0xB
{
  const r = await probe(token, [clientFrame({ opcode: 0xb })])
  check('保留控制帧 0xB 被拒（1002）', r.closeCode === 1002,
    `closeCode=${r.closeCode} reason="${r.closeReason}"`)
}

// 8. Continuation 帧（本项目不支持分片）
{
  const r = await probe(token, [clientFrame({ opcode: 0x0, payload: Buffer.from('x') })])
  check('Continuation 帧被拒（1002）', r.closeCode === 1002,
    `closeCode=${r.closeCode} reason="${r.closeReason}"`)
}

// 9. 分片起始帧（FIN=0）本身是合法的 —— 连接必须保持打开，不能被当成协议错误
//    （早期一版曾错误地拒绝分片，导致浏览器上传全部失败、进度永远 0%）
{
  const r = await probe(token, [clientFrame({ opcode: 0x1, fin: false, payload: Buffer.from('x') })])
  check('分片起始帧 FIN=0 被接受（不断开）', r.closeCode === null,
    `closeCode=${r.closeCode} 服务端帧=${JSON.stringify(r.opcodes)}`)
}

// 10. 客户端帧未加掩码
{
  const r = await probe(token, [clientFrame({ opcode: 0x1, masked: false, payload: Buffer.from('x') })])
  check('未掩码帧被拒（1002）', r.closeCode === 1002,
    `closeCode=${r.closeCode} reason="${r.closeReason}"`)
}

// 11. RSV1 置位（未协商扩展）
{
  const r = await probe(token, [clientFrame({ opcode: 0x1, rsv: 0x4, payload: Buffer.from('x') })])
  check('RSV1 置位被拒（1002）', r.closeCode === 1002,
    `closeCode=${r.closeCode} reason="${r.closeReason}"`)
}

// 12. 控制帧 payload 超过 125 字节
{
  const r = await probe(token, [clientFrame({ opcode: 0x9, payload: Buffer.alloc(200, 0x41) })])
  check('控制帧 payload > 125 被拒（1002）', r.closeCode === 1002,
    `closeCode=${r.closeCode} reason="${r.closeReason}"`)
}

// 13. 正常 Close(1000) → 服务端必须回 Close(1000)，而不是直接断开
{
  const r = await probe(token, [clientFrame({ opcode: 0x8, payload: Buffer.from([0x03, 0xe8]) })])
  check('正常关闭握手回 Close(1000)', r.closeCode === 1000 && r.tcpClosed,
    `closeCode=${r.closeCode} tcpClosed=${r.tcpClosed}`)
}

// ═══════ 分片消息 ═══════
//
// ★ 为什么这几项最重要：浏览器的 WebSocket 会对较大的消息自动分片。
//   实测 Chrome 阈值：≤ 65536 B 单帧，≥ 131072 B 就分片。
//   而本项目的文件分块是 256 KB —— 所以「浏览器上传」时**每一块都会被分片**，
//   这是主路径而不是边缘情况。曾经有一段代码因为「浏览器永远发 FIN=1」
//   这个错误假设而拒绝了分片，结果浏览器端上传 100% 失败（进度永远 0%、
//   连接反复断开），而下面这些用 Node 手写单帧的测试却全部通过。

// 14. ★ 合法分片：Text 消息拆成 3 帧，服务端必须重组后正常处理
{
  const marker = '分片重组-' + Date.now()
  const b = Buffer.from(JSON.stringify({ type: 'group', groupId: 'public', content: marker }))
  const c1 = Math.floor(b.length / 3), c2 = Math.floor(b.length * 2 / 3)
  const r = await probe(token, [
    clientFrame({ opcode: 0x1, fin: false, payload: b.subarray(0, c1) }),
    clientFrame({ opcode: 0x0, fin: false, payload: b.subarray(c1, c2) }),
    clientFrame({ opcode: 0x0, fin: true, payload: b.subarray(c2) }),
  ])
  // 注意：服务端 JSON 序列化默认会把非 ASCII 转义成 \uXXXX，
  // 所以不能对原始文本做子串匹配，必须解析 JSON 后比较字段
  const echoed = r.texts.some((t) => {
    try { return JSON.parse(t).Content === marker } catch { return false }
  })
  check('★ 分片 Text 消息被正确重组并处理', echoed && r.closeCode === null,
    `重组后内容匹配=${echoed} closeCode=${r.closeCode} 收到文本帧数=${r.texts.length}`)
}

// 15. ★ 完全模仿 Chrome：Binary 按 64KB 分片，总量 = 一个 256KB 分块帧的大小
{
  const total = 262154
  const per = 65536
  const frames = []
  for (let off = 0; off < total; off += per) {
    const len = Math.min(per, total - off)
    frames.push(clientFrame({
      opcode: off === 0 ? 0x2 : 0x0,
      fin: off + len >= total,
      payload: Buffer.alloc(len),
    }))
  }
  const r = await probe(token, frames)
  // 这不是合法的 FT 帧，服务端会回 Error 帧；关键是帧层不应把它当协议错误断开
  check('★ 模仿 Chrome 的 64KB 分片 Binary 被接受', r.closeCode === null,
    `帧数=${frames.length} closeCode=${r.closeCode} 服务端帧=${JSON.stringify(r.opcodes)}`)
}

// 16. 分片中间插入 Ping（RFC 允许控制帧插在分片之间）: 应回 Pong 且消息仍能重组
{
  const marker = '分片插Ping-' + Date.now()
  const b = Buffer.from(JSON.stringify({ type: 'group', groupId: 'public', content: marker }))
  const cut = Math.floor(b.length / 2)
  const r = await probe(token, [
    clientFrame({ opcode: 0x1, fin: false, payload: b.subarray(0, cut) }),
    clientFrame({ opcode: 0x9, payload: Buffer.from('mid') }),
    clientFrame({ opcode: 0x0, fin: true, payload: b.subarray(cut) }),
  ])
  const pong = r.opcodes.includes('0xa')
  const echoed = r.texts.some((t) => {
    try { return JSON.parse(t).Content === marker } catch { return false }
  })
  check('分片中间插入 Ping 仍能正确重组（并回 Pong）', pong && echoed && r.closeCode === null,
    `回Pong=${pong} 内容匹配=${echoed} closeCode=${r.closeCode}`)
}

// 17. 没有起始帧就来续帧 → 1002
{
  const r = await probe(token, [clientFrame({ opcode: 0x0, fin: true, payload: Buffer.from('x') })])
  check('无起始帧的续帧被拒（1002）', r.closeCode === 1002,
    `closeCode=${r.closeCode} reason="${r.closeReason}"`)
}

// 18. 分片未完又来新的 Text → 1002
{
  const r = await probe(token, [
    clientFrame({ opcode: 0x1, fin: false, payload: Buffer.from('abc') }),
    clientFrame({ opcode: 0x1, fin: true, payload: Buffer.from('def') }),
  ])
  check('分片未完又来新 Text 被拒（1002）', r.closeCode === 1002,
    `closeCode=${r.closeCode} reason="${r.closeReason}"`)
}

// 19. 分片累计超过 1MB → 1009（每一单帧都在限内，靠累计上限拦住）
{
  const frames = [clientFrame({ opcode: 0x2, fin: false, payload: Buffer.alloc(524288) })]
  for (let i = 0; i < 4; i++)
    frames.push(clientFrame({ opcode: 0x0, fin: false, payload: Buffer.alloc(262144) }))
  frames.push(clientFrame({ opcode: 0x0, fin: true, payload: Buffer.alloc(1024) }))
  const r = await probe(token, frames)
  check('分片累计超 1MB 被拒（1009）', r.closeCode === 1009,
    `closeCode=${r.closeCode} reason="${r.closeReason}"`)
}

// ─────────────────────────── 汇总 ───────────────────────────

console.log('\n===== 汇总 =====')
const passed = results.filter((r) => r.ok).length
console.log(`${passed}/${results.length} 通过`)
if (passed !== results.length) {
  console.log('\n未通过项：')
  for (const r of results.filter((x) => !x.ok)) console.log(`  - ${r.label}: ${r.detail}`)
}
process.exit(passed === results.length ? 0 : 1)
