// 裸 TCP 探针：手动完成 WS 握手，验证「Sec-WebSocket-Key 不在最后」时后端是否会解析错乱
// 用法: node ws-raw-probe.mjs
import net from 'node:net'
import crypto from 'node:crypto'

const API = 'http://localhost:5258'

function maskFrame(payload) {
  const key = crypto.randomBytes(4)
  const len = payload.length
  let header
  if (len < 126) {
    header = Buffer.from([0x81, 0x80 | len])
  } else if (len < 65536) {
    header = Buffer.alloc(4)
    header[0] = 0x81; header[1] = 0x80 | 126; header.writeUInt16BE(len, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = 0x81; header[1] = 0x80 | 127; header.writeBigUInt64BE(BigInt(len), 2)
  }
  const masked = Buffer.from(payload)
  for (let i = 0; i < masked.length; i++) masked[i] ^= key[i % 4]
  return Buffer.concat([header, key, masked])
}

function buildRequest(token, keyFirst) {
  const wsKey = crypto.randomBytes(16).toString('base64')
  const common = [
    `GET /ws?token=${encodeURIComponent(token)} HTTP/1.1`,
    `Host: localhost:5259`,
    `Connection: Upgrade`,
    `Upgrade: websocket`,
    `Sec-WebSocket-Version: 13`
  ]
  const keyLine = `Sec-WebSocket-Key: ${wsKey}`
  const tail = [
    `Sec-WebSocket-Extensions: permessage-deflate; client_max_window_bits`,
    `Origin: http://localhost:5173`
  ]
  // keyFirst=true 模拟「Key 之后还有其他头」的情况（会导致残留未读）
  const lines = keyFirst
    ? [...common.slice(0, 4), keyLine, ...common.slice(4), ...tail]
    : [...common, ...tail, keyLine]
  return lines.join('\r\n') + '\r\n\r\n'
}

async function probe(label, keyFirst) {
  const loginRes = await fetch(`${API}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nickname: '测试用户C', email: 'testC@chat.com', password: 'password123' })
  })
  const { token } = await loginRes.json()

  return new Promise((resolve) => {
    const sock = net.connect(5259, '127.0.0.1')
    const chunks = []
    let handshakeDone = false
    const payload = JSON.stringify({ Type: 'group', Content: '裸探针测试-' + label })

    sock.on('connect', () => sock.write(buildRequest(token, keyFirst)))
    sock.on('data', (d) => {
      chunks.push(d)
      if (!handshakeDone && d.includes(Buffer.from('\r\n\r\n'))) {
        handshakeDone = true
        sock.write(maskFrame(Buffer.from(payload)))
      }
    })
    sock.on('error', () => {})
    setTimeout(() => {
      sock.destroy()
      const raw = Buffer.concat(chunks)
      const text = raw.toString('utf8')
      const head = text.slice(0, text.indexOf('\r\n\r\n'))
      const body = raw.subarray(text.indexOf('\r\n\r\n') + 4)
      resolve({ label, statusLine: head.split('\r\n')[0], bodyBytes: body.length, bodyHex: body.subarray(0, 24).toString('hex') })
    }, 3000)
  })
}

const r1 = await probe('Key在中间', true)
console.log('【A】Sec-WebSocket-Key 之后还有其他头:')
console.log('   ', JSON.stringify(r1))
const r2 = await probe('Key在最后', false)
console.log('【B】Sec-WebSocket-Key 是最后一个头:')
console.log('   ', JSON.stringify(r2))
