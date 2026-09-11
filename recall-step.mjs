// 分两步执行，便于在中间用浏览器观察 UI
//   发消息: node recall-step.mjs send
//   撤回:   node recall-step.mjs recall <messageId>
const API = 'http://localhost:5258'
const WS = 'ws://localhost:5259/ws'

const login = await (await fetch(`${API}/api/auth/login`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ nickname: '测试用户C', email: 'testC@chat.com', password: 'password123' })
})).json()
const token = login.token
const mode = process.argv[2]

if (mode === 'send') {
  const marker = '撤回观察-' + Date.now()
  const ws = new WebSocket(`${WS}?token=${token}`)
  await new Promise(r => ws.onopen = r)
  let id = null
  ws.onmessage = (e) => {
    if (typeof e.data !== 'string') return
    const m = JSON.parse(e.data)
    if (m.Type === 'group' && m.Content === marker) id = m.Id
  }
  ws.send(JSON.stringify({ type: 'group', groupId: 'public', content: marker }))
  await new Promise(r => setTimeout(r, 1500))
  ws.close()
  console.log(JSON.stringify({ marker, messageId: id }))
  process.exit(0)
}

if (mode === 'recall') {
  const id = process.argv[3]
  const res = await fetch(`${API}/api/message/${id}/recall`, {
    method: 'PUT', headers: { Authorization: `Bearer ${token}` }
  })
  console.log('recall ->', res.status, await res.text())
  process.exit(0)
}

console.log('用法: node recall-step.mjs send | recall <messageId>')
