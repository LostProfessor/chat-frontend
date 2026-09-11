// 撤回链路实测：发消息 → 撤回 → 抓撤回广播 → 查历史
// 用法: node recall-test.mjs
const API = 'http://localhost:5258'
const WS = 'ws://localhost:5259/ws'

const login = await (await fetch(`${API}/api/auth/login`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ nickname: '测试用户C', email: 'testC@chat.com', password: 'password123' })
})).json()
const token = login.token
console.log('登录 OK, publicId =', login.publicId)

const ws = new WebSocket(`${WS}?token=${token}`)
const inbox = []
let sentId = null
let recallFrame = null

ws.onmessage = (e) => {
  if (typeof e.data !== 'string') return
  const m = JSON.parse(e.data)
  inbox.push(m)
  if (m.Type === 'group' && m.Content?.startsWith('撤回测试') && !sentId) {
    sentId = m.Id
    console.log('\n[1] 收到自己消息的广播, 后端 Id =', m.Id)
    console.log('    广播里的 Content =', JSON.stringify(m.Content))
  }
  if (m.Type === 'recall') {
    recallFrame = m
  }
}

await new Promise(r => ws.onopen = r)
const content = '撤回测试-' + Date.now()
ws.send(JSON.stringify({ type: 'group', groupId: 'public', content }))
await new Promise(r => setTimeout(r, 1200))

if (!sentId) { console.log('!! 没收到自己的消息广播'); process.exit(1) }

// ── 撤回 ──
const recallRes = await fetch(`${API}/api/message/${sentId}/recall`, {
  method: 'PUT', headers: { Authorization: `Bearer ${token}` }
})
console.log('\n[2] PUT /api/message/{id}/recall ->', recallRes.status, await recallRes.text())
await new Promise(r => setTimeout(r, 1200))

console.log('\n[3] 撤回广播内容 =', recallFrame ? JSON.stringify(recallFrame) : '（没收到）')
if (recallFrame) {
  console.log('    广播的 MessageId =', recallFrame.MessageId)
  console.log('    消息的 Id        =', sentId)
  console.log('    → 是否相等       =', recallFrame.MessageId === sentId)
}

// ── 查历史 ──
const history = await (await fetch(`${API}/api/group/public/history?count=30`, {
  headers: { Authorization: `Bearer ${token}` }
})).json()
const found = history.find(m => m.Id === sentId)
console.log('\n[4] 历史接口里这条消息:')
console.log('    对象字段 =', found ? Object.keys(found).join(', ') : '（没找到）')
if (found) {
  console.log('    有 IsRecalled 字段吗 =', 'IsRecalled' in found)
  console.log('    Content 仍是原文吗   =', found.Content === content, '→', JSON.stringify(found.Content))
}
ws.close()
process.exit(0)
