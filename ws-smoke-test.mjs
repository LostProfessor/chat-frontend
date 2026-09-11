// WS 层冒烟测试：握手+JWT、文本消息、二进制文件传输（Start/Chunk/Done）
// 用法: node ws-smoke-test.mjs
import fs from 'node:fs'

const API = 'http://localhost:5258'
const WS = 'ws://localhost:5259/ws'
const FT_MAGIC = 0xAB
const OP = { Start: 1, Chunk: 2, Ack: 3, Done: 4, Cancel: 5, Error: 6, Resume: 7 }
const CHUNK = 256 * 1024

function encodeFT(op, sessionId, seq, payload) {
  const buf = new Uint8Array(10 + payload.length)
  const dv = new DataView(buf.buffer)
  dv.setUint8(0, FT_MAGIC)
  dv.setUint8(1, op)
  dv.setInt32(2, sessionId, false)
  dv.setInt32(6, seq, false)
  buf.set(payload, 10)
  return buf
}

function parseFT(data) {
  const bytes = new Uint8Array(data)
  if (bytes.length < 10 || bytes[0] !== FT_MAGIC) return null
  const dv = new DataView(data)
  return { op: bytes[1], sessionId: dv.getInt32(2, false), seq: dv.getInt32(6, false), payload: bytes.slice(10) }
}

const results = []
const log = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -> ' + detail : ''}`)
}

// 1. 登录拿 token
const loginRes = await fetch(`${API}/api/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ nickname: '测试用户C', email: 'testC@chat.com', password: 'password123' })
})
const login = await loginRes.json()
log('HTTP 登录', loginRes.status === 200 && !!login.token, `status=${loginRes.status}`)
const token = login.token

// 2. WS 握手（带 JWT）
const ws = new WebSocket(`${WS}?token=${token}`)
ws.binaryType = 'arraybuffer'

const openOk = await new Promise((resolve) => {
  const t = setTimeout(() => resolve(false), 5000)
  ws.onopen = () => { clearTimeout(t); resolve(true) }
  ws.onerror = () => { clearTimeout(t); resolve(false) }
})
log('WS 握手 + JWT 鉴权', openOk)
if (!openOk) { console.log(JSON.stringify(results, null, 2)); process.exit(1) }

// 3. 发送文本消息，等广播回来（上行小写 type/groupId/content，下行 PascalCase）
const textEcho = await new Promise((resolve) => {
  const t = setTimeout(() => resolve(null), 5000)
  ws.onmessage = (e) => {
    if (typeof e.data === 'string') {
      const m = JSON.parse(e.data)
      if (m.Type === 'group' || m.Type === 'chat') { clearTimeout(t); resolve(m) }
    }
  }
  ws.send(JSON.stringify({ type: 'group', groupId: 'public', content: 'WS冒烟测试' }))
})
log('WS 文本消息发送+接收', !!textEcho, textEcho ? `Id=${textEcho.Id}` : '超时未收到广播')

// 4. 二进制文件传输（>=2 个块，非法块整数倍以覆盖边界）
const filePath = process.argv[2]
const fileBuf = fs.readFileSync(filePath)
const fileName = filePath.split(/[\\/]/).pop()
const total = fileBuf.length
const totalChunks = Math.ceil(total / CHUNK)

const donePayload = await new Promise((resolve) => {
  let sessionId = 0
  let acked = 0
  let sent = 0
  const t = setTimeout(() => resolve(null), 60000)

  ws.onmessage = (e) => {
    if (!(e.data instanceof ArrayBuffer)) return
    const f = parseFT(e.data)
    if (!f) return
    if (f.op === OP.Ack) {
      if (sessionId === 0) {
        sessionId = f.sessionId
        log('FT Start -> ACK 分配 SessionId', sessionId > 0, `sessionId=${sessionId}`)
        pump()
      } else {
        acked = f.seq
        if (sent >= totalChunks && acked >= total) {
          ws.send(encodeFT(OP.Done, sessionId, 0, new Uint8Array(0)))
        } else { pump() }
      }
    } else if (f.op === OP.Done) {
      clearTimeout(t)
      resolve(JSON.parse(new TextDecoder().decode(f.payload)))
    } else if (f.op === OP.Error) {
      clearTimeout(t)
      resolve({ error: new TextDecoder().decode(f.payload) })
    }
  }

  function pump() {
    while (sent < totalChunks) {
      const start = sent * CHUNK
      const end = Math.min(start + CHUNK, total)
      ws.send(encodeFT(OP.Chunk, sessionId, sent, new Uint8Array(fileBuf.subarray(start, end))))
      sent++
    }
    if (sent >= totalChunks && acked >= total) ws.send(encodeFT(OP.Done, sessionId, 0, new Uint8Array(0)))
  }

  const meta = new TextEncoder().encode(JSON.stringify({
    fileName, mediaType: /\.(png|jpg|jpeg|gif|webp)$/i.test(fileName) ? 'image' : 'file',
    totalSize: total, roomId: 'public'
  }))
  ws.send(encodeFT(OP.Start, 0, 0, meta))
})

if (!donePayload || donePayload.error) {
  log('FT 分块上传 -> DONE', false, donePayload?.error || '超时/无响应')
} else {
  log('FT 分块上传 -> DONE', true, `messageId=${donePayload.messageId} url=${donePayload.mediaUrl}`)
  // 5. 下载回来校验字节一致
  const dl = await fetch(API + donePayload.mediaUrl)
  const dlBuf = Buffer.from(await dl.arrayBuffer())
  const sameSize = dlBuf.length === total
  const sameBytes = sameSize && dlBuf.equals(fileBuf)
  log('落盘文件字节一致性', sameBytes, `源=${total}B 服务端=${dlBuf.length}B`)
}

ws.close()
console.log('\n===== 汇总 =====')
console.log(`${results.filter(r => r.ok).length}/${results.length} 通过`)
process.exit(results.every(r => r.ok) ? 0 : 1)
