<script setup>
import { ref, computed, onMounted, onBeforeUnmount, nextTick } from 'vue'
import { useRouter } from 'vue-router'
import api, {
  createWebSocket, searchUsers, sendFriendRequest,
  getFriends, getPendingRequests, acceptFriendRequest, rejectFriendRequest,
  changeNickname, changeEmail, changePassword,
  getProfile, uploadAvatar, deleteAvatar,
  refreshAccessToken,
  createGroup, getMyGroups, searchGroups, joinGroup,
  getGroupMembers, getAnnouncement, setAnnouncement,
  changeRole, removeMember, getGroupHistory, updateGroupSettings,
  recallMessage, muteMember, unmuteMember, changeGroupName,
  getAdminUsers, deleteUser, getAdminGroups, deleteGroup, setGlobalAnnouncement,
  resetUserPassword
} from '../api'

const router = useRouter()

const API_BASE = api.defaults.baseURL || 'http://localhost:5258'

/** 把后端返回的相对路径（如 /uploads/avatars/xxx.jpg）拼成完整 URL */
function resolveUrl(path) {
  if (!path) return null
  return path.startsWith('http') ? path : API_BASE + path
}

const nickname = ref(sessionStorage.getItem('nickname') || '')
const publicId = ref(sessionStorage.getItem('publicId') || '')
const myAvatarUrl = ref(resolveUrl(sessionStorage.getItem('avatarUrl')))
const msgInput = ref(null)
const messageList = ref(null)
const connectionStatus = ref('正在连接...')
let socket = null

const currentRoom = ref({ type: 'group', id: 'public', name: '全服大厅' })
const messages = ref([])
const groupList = ref([{ id: 'public', name: '全服大厅', unread: 0 }])
const activeTab = ref('groups')

// 群组弹窗
const showCreateGroup = ref(false)
const newGroupName = ref('')
const showJoinGroup = ref(false)
const joinSearchQuery = ref('')
const joinSearchResults = ref([])
// 公告
const announcement = ref('')
const showAnnouncement = ref(false)
// 成员列表
const showMembers = ref(false)
const memberList = ref([])

// 设置面板
const showSettingsPanel = ref(false)
const settingsPanelTab = ref('members')
const contextMenuMsg = ref(null)
const contextMenuPos = ref({ x: 0, y: 0 })

async function doRecall(msg) {
  // 撤回必须用后端真实消息 Id（msg.backendId）；本地插入的消息用 DONE 返回的 messageId
  const id = msg?.backendId || msg?.id
  try { await recallMessage(id); contextMenuMsg.value = null }
  catch (e) { alert('撤回失败') }
}

async function doMute(userId) {
  try { await muteMember(currentRoom.value.id, userId); await loadMembers() }
  catch (e) { alert('操作失败') }
}

async function doUnmute(userId) {
  try { await unmuteMember(currentRoom.value.id, userId); await loadMembers() }
  catch (e) { alert('操作失败') }
}

function openContextMenu(e, msg) {
  if (!msg.isSelf && myGroupRole.value > 1 && !isAdmin.value) return // 不是自己的且不是管理/系统管理
  if (msg.recalled) return
  contextMenuMsg.value = msg
  contextMenuPos.value = { x: e.clientX, y: e.clientY }
}

// 好友相关
const privateList = ref([])
const pendingRequests = ref([])
const showAddFriend = ref(false)
const searchQuery = ref('')
const searchResults = ref([])
const showPendingPanel = ref(false)

// 个人信息设置弹窗
const showSettings = ref(false)
const settingsTab = ref('nickname')
const newNickname = ref('')
const newEmail = ref('')
const oldPwd = ref('')
const newPwd = ref('')
const confirmPwd = ref('')
const settingsMsg = ref('')
const settingsError = ref('')
const settingsLoading = ref(false)

// ====== 头像 ======
const avatarFileInput = ref(null)

async function loadMyAvatar() {
  try {
    const res = await getProfile()
    const url = res.data.AvatarUrl || res.data.avatarUrl
    if (url) {
      myAvatarUrl.value = resolveUrl(url)
      sessionStorage.setItem('avatarUrl', url)
    }
  } catch (e) {}
}

function triggerAvatarInput() {
  avatarFileInput.value?.click()
}

async function onAvatarSelected(e) {
  const file = e.target.files?.[0]
  e.target.value = '' // 允许重复选同一个文件
  if (!file) return
  // 前端简单校验
  if (!/image\/(jpeg|png|gif|webp)/.test(file.type)) { alert('仅支持 jpg/png/gif/webp 图片'); return }
  if (file.size > 3 * 1024 * 1024) { alert('图片不能超过 3MB'); return }
  settingsLoading.value = true
  settingsError.value = ''
  try {
    const res = await uploadAvatar(file)
    const url = res.data.avatarUrl || res.data.AvatarUrl
    myAvatarUrl.value = resolveUrl(url)
    sessionStorage.setItem('avatarUrl', url)
    settingsMsg.value = '头像上传成功'
  } catch (err) {
    settingsError.value = err.response?.data?.message || err.response?.data || '上传失败'
  } finally { settingsLoading.value = false }
}

async function doRemoveAvatar() {
  if (!confirm('确定要恢复默认头像吗？')) return
  settingsLoading.value = true
  settingsError.value = ''
  try {
    await deleteAvatar()
    myAvatarUrl.value = null
    sessionStorage.removeItem('avatarUrl')
    settingsMsg.value = '已恢复默认头像'
  } catch (err) {
    settingsError.value = err.response?.data?.message || err.response?.data || '操作失败'
  } finally { settingsLoading.value = false }
}

// ====== 图片消息传输（P0：基于 WebSocket Binary 分块上传） ======

const imageFileInput = ref(null)
const uploading = ref(false)
const uploadProgress = ref(0)
const uploadFileName = ref('')
const previewImage = ref(null)

// 文件传输协议常量（与后端 FileTransferCodec 保持一致）
const FT_MAGIC = 0xAB
const FT_OP = { Start: 1, Chunk: 2, Ack: 3, Done: 4, Cancel: 5, Error: 6, Resume: 7 }
const FT_CHUNK_SIZE = 256 * 1024 // 每块 256KB

// 当前上传状态（非响应式，只供发送逻辑内部使用）
let pendingUpload = null // { file, sessionId, totalChunks, sent, roomId }

/** 字符串 → Uint8Array */
function str2ab(str) {
  return new TextEncoder().encode(str)
}

/** 编码一个文件传输帧：头部10字节 + payload */
function encodeFT(op, sessionId, seq, payload) {
  const header = new ArrayBuffer(10)
  const dv = new DataView(header)
  dv.setUint8(0, FT_MAGIC)
  dv.setUint8(1, op)
  dv.setInt32(2, sessionId, false) // 大端
  dv.setInt32(6, seq, false)
  const buf = new Uint8Array(10 + payload.length)
  buf.set(new Uint8Array(header), 0)
  buf.set(payload, 10)
  return buf
}

/** 解析一个文件传输帧（ArrayBuffer → {op, sessionId, seq, payload}） */
function parseFT(data) {
  const bytes = new Uint8Array(data)
  if (bytes.length < 10 || bytes[0] !== FT_MAGIC) return null
  const dv = new DataView(data)
  return {
    op: bytes[1],
    sessionId: dv.getInt32(2, false),
    seq: dv.getInt32(6, false),
    payload: bytes.slice(10)
  }
}

function triggerImageInput() { imageFileInput.value?.click() }

/** 选择图片后开始分块上传 */
async function onImageSelected(e) {
  const file = e.target.files?.[0]
  e.target.value = ''
  if (!file) return
  // 校验类型与大小
  if (!/image\/(jpeg|png|gif|webp)/.test(file.type)) { alert('仅支持 jpg/png/gif/webp 图片'); return }
  if (file.size > 50 * 1024 * 1024) { alert('图片不能超过 50MB'); return }
  if (!socket || socket.readyState !== WebSocket.OPEN) { alert('连接未就绪'); return }

  // 重置上传状态
  pendingUpload = {
    file,
    sessionId: 0,
    totalChunks: Math.ceil(file.size / FT_CHUNK_SIZE),
    sent: 0,
    roomId: currentRoom.value.id
  }
  uploading.value = true
  uploadProgress.value = 0
  uploadFileName.value = file.name

  // 发送 START 帧（SessionId 为 0，等待服务端 ACK 分配）
  const meta = str2ab(JSON.stringify({
    fileName: file.name,
    mediaType: 'image',
    totalSize: file.size,
    roomId: currentRoom.value.id
  }))
  socket.send(encodeFT(FT_OP.Start, 0, 0, meta))
}

/** 断点续传：WS 重连后，用上次的 SessionId 让服务端回传已收字节数，从断点继续 */
function resumeUpload() {
  const up = pendingUpload
  if (!up || up.sessionId === 0 || !socket || socket.readyState !== WebSocket.OPEN) return
  up.resuming = true
  uploading.value = true
  socket.send(encodeFT(FT_OP.Resume, up.sessionId, 0, new Uint8Array(0)))
}

let sendingChunk = false // sendNextChunk 重入锁，防止并发调用导致跳块

const CHUNK_TIMEOUT_MS = 15000 // 单块 15s 内未收到 ACK 则视为超时，自动重传
let chunkRetryTimer = null

function clearChunkRetryTimer() {
  if (chunkRetryTimer) { clearTimeout(chunkRetryTimer); chunkRetryTimer = null }
}

/** 发送下一块数据（收到 ACK 后调用，形成简单滑动窗口） */
async function sendNextChunk() {
  if (sendingChunk) return
  const up = pendingUpload
  if (!up || !socket || socket.readyState !== WebSocket.OPEN) return
  sendingChunk = true
  try {
    clearChunkRetryTimer()
    if (up.sent >= up.totalChunks) {
      // 所有块已发完 → DONE
      socket.send(encodeFT(FT_OP.Done, up.sessionId, 0, new Uint8Array(0)))
      return
    }
    const idx = up.sent
    const start = idx * FT_CHUNK_SIZE
    const end = Math.min(start + FT_CHUNK_SIZE, up.file.size)
    const blob = up.file.slice(start, end)
    const buf = await blob.arrayBuffer()
    socket.send(encodeFT(FT_OP.Chunk, up.sessionId, idx, new Uint8Array(buf)))
    up.sent = idx + 1

    // 块超时重传：发出后 15s 内未收到该块的 ACK（sent 未被推进），则回退重发
    chunkRetryTimer = setTimeout(() => {
      const cur = pendingUpload
      if (cur && cur.sent === idx + 1) {
        cur.sent = idx // 回退到未确认的块
        sendNextChunk()
      }
    }, CHUNK_TIMEOUT_MS)
  } finally {
    sendingChunk = false
  }
}

/** 取消上传：通知服务端废弃会话，并清理本地状态 */
function cancelUpload() {
  const up = pendingUpload
  if (!up) return
  if (up.sessionId !== 0 && socket && socket.readyState === WebSocket.OPEN) {
    socket.send(encodeFT(FT_OP.Cancel, up.sessionId, 0, new Uint8Array(0)))
  }
  finishUpload()
}

/** 处理收到的文件传输帧（ACK/DONE/ERROR） */
function handleFTFrame(frame) {
  const up = pendingUpload
  switch (frame.op) {
    case FT_OP.Ack:
      if (up && up.resuming) {
        // Resume 的 ACK：seq 携带已收字节数 → 计算下一个块索引，从断点继续
        up.resuming = false
        const receivedBytes = frame.seq
        up.sent = Math.floor(receivedBytes / FT_CHUNK_SIZE)
        uploadProgress.value = (receivedBytes / up.file.size) * 100
        sendNextChunk()
      } else if (up && up.sessionId === 0) {
        // START 的 ACK：拿到服务端分配的 SessionId，开始发块
        up.sessionId = frame.sessionId
        sendNextChunk()
      } else if (up) {
        // 进度 ACK：seq 携带已收字节数
        uploadProgress.value = (frame.seq / up.file.size) * 100
        sendNextChunk()
      }
      break
    case FT_OP.Done:
      // 服务端确认完成（payload 含图片元数据，前端直接本地渲染一次）
      try {
        const meta = JSON.parse(new TextDecoder().decode(frame.payload))
        addLocalImageMessage(meta)
      } catch (e) { /* 忽略解析失败 */ }
      finishUpload()
      break
    case FT_OP.Error:
      alert(new TextDecoder().decode(frame.payload) || '上传失败')
      finishUpload()
      break
  }
}

/** 上传结束（成功/失败/取消）：清理状态 */
function finishUpload() {
  clearChunkRetryTimer()
  pendingUpload = null
  uploading.value = false
  uploadProgress.value = 0
  uploadFileName.value = ''
}

/** 本地立即插入一条图片消息（发送者本人即时可见，不等广播回传） */
function addLocalImageMessage(meta) {
  // 若广播已先到达并插入同一条，这里跳过，避免重复显示
  const mediaUrl = resolveUrl(meta.mediaUrl || meta.MediaUrl)
  if (messages.value.some(m => m.mediaUrl && m.mediaUrl === mediaUrl)) return

  messages.value.push({
    id: 'local_img_' + Date.now() + '_' + Math.random(),
    backendId: meta.messageId || meta.MessageId,
    type: 'group',
    senderId: publicId.value,
    senderNickname: nickname.value,
    content: '',
    roomId: pendingUpload?.roomId || currentRoom.value.id,
    time: formatTime(new Date().toISOString()),
    isSelf: true,
    mediaUrl,
    mediaThumbUrl: resolveUrl(meta.mediaThumbUrl || meta.MediaThumbUrl) || mediaUrl,
    mediaName: meta.mediaName || meta.MediaName,
    mediaSize: meta.mediaSize || meta.MediaSize
  })
  nextTick(() => { if (messageList.value) messageList.value.scrollTop = messageList.value.scrollHeight })
}

// ====== 管理员面板 ======
const isAdmin = ref(sessionStorage.getItem('isAdmin') === 'true')
const showAdminPanel = ref(false)
const adminTab = ref('users')
const adminUsers = ref([])
const adminGroups = ref([])
const adminAnnContent = ref('')

const filteredMessages = computed(() => {
  return messages.value.filter(msg => {
    if (currentRoom.value.type === 'group') {
      return msg.roomId === currentRoom.value.id
    } else {
      return msg.type === 'private' &&
        (msg.senderId === currentRoom.value.id || msg.targetId === currentRoom.value.id)
    }
  })
})

const roomTitle = computed(() => currentRoom.value.name)

function formatTime(timestamp) {
  if (!timestamp) return ''
  const d = new Date(timestamp)
  return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`
}

function connectWebSocket() {
  const token = sessionStorage.getItem('token')
  if (!token) { connectionStatus.value = '未登录'; return }
  socket = createWebSocket(token)
  socket.binaryType = 'arraybuffer' // 二进制帧以 ArrayBuffer 接收（文件传输）

  socket.onopen = () => {
    connectionStatus.value = '已连接'
    // 断线重连后：若存在未完成的上传（sessionId 已分配），从断点续传
    if (pendingUpload && pendingUpload.sessionId !== 0) {
      resumeUpload()
    }
  }
  socket.onmessage = (event) => {
    // ── 二进制帧：文件传输（ACK/DONE/ERROR） ──
    if (event.data instanceof ArrayBuffer) {
      const frame = parseFT(event.data)
      if (frame) handleFTFrame(frame)
      return
    }

    try {
      const msg = JSON.parse(event.data)
      switch (msg.Type) {
        case 'group':
        case 'chat':
          messages.value.push({
            id: (msg.SenderId||'') + '_' + (msg.Timestamp||Date.now()),
            backendId: msg.Id,
            type: 'group', senderId: msg.SenderId, senderNickname: msg.SenderNickname,
            content: msg.Content, roomId: msg.TargetUserId || 'public',
            time: formatTime(msg.Timestamp), rawTimestamp: msg.Timestamp,
            avatarUrl: resolveUrl(msg.AvatarUrl),
            isSelf: msg.SenderId === publicId.value
          })
          break
        case 'image': {
          // 广播的图片消息。发送者本地已立即插入一条（addLocalImageMessage），
          // 这里按 mediaUrl 去重，避免自己看到两条。
          const mediaUrl = resolveUrl(msg.MediaUrl)
          const dup = messages.value.find(m => m.mediaUrl && m.mediaUrl === mediaUrl)
          if (dup) break
          messages.value.push({
            id: (msg.SenderId||'') + '_' + (msg.Timestamp||Date.now()),
            backendId: msg.Id,
            type: 'group', senderId: msg.SenderId, senderNickname: msg.SenderNickname,
            content: msg.Content || '', roomId: msg.TargetUserId || 'public',
            time: formatTime(msg.Timestamp), rawTimestamp: msg.Timestamp,
            avatarUrl: resolveUrl(msg.AvatarUrl),
            mediaUrl,
            mediaThumbUrl: resolveUrl(msg.MediaThumbUrl) || mediaUrl,
            mediaName: msg.MediaName,
            mediaSize: msg.MediaSize,
            isSelf: msg.SenderId === publicId.value
          })
          break
        }
        case 'private':
          messages.value.push({
            id: (msg.SenderId||'') + '_' + (msg.Timestamp||Date.now()),
            backendId: msg.Id,
            type: 'private', senderId: msg.SenderId, targetId: msg.TargetUserId,
            senderNickname: msg.SenderNickname, content: msg.Content,
            time: formatTime(msg.Timestamp),
            avatarUrl: resolveUrl(msg.AvatarUrl),
            isSelf: msg.SenderId === publicId.value
          })
          break
        case 'error': console.error("服务器错误:", msg.Message || msg.message); break
        case 'pong': break
        case 'recall':
          const found = messages.value.find(m => m.id === (msg.MessageId || msg.messageId))
          if (found) { found.recalled = true; found.content = '[消息已被撤回]' }
          break
        case 'system':
          messages.value.push({
            id: 'sys_' + Date.now() + '_' + Math.random(),
            type: 'system',
            content: msg.Content || msg.content || '',
            roomId: msg.groupId || msg.GroupId || msg.TargetUserId || 'public',
            time: formatTime(new Date().toISOString())
          })
          break
      }
      nextTick(() => { if (messageList.value) messageList.value.scrollTop = messageList.value.scrollHeight })
    } catch (e) { console.error("消息解析失败:", e) }
  }
  socket.onerror = () => { connectionStatus.value = '连接失败' }
  socket.onclose = () => {
    connectionStatus.value = '已断开'
    // access token 过期会导致 WS 断开，尝试用 refresh token 重连
    tryReconnect()
  }
}

// ====== WebSocket 自动重连（access token 过期场景） ======
let reconnectAttempts = 0
const MAX_RECONNECT = 3

async function tryReconnect() {
  // 未登录或已主动退出时不重连
  if (!sessionStorage.getItem('refreshToken')) return
  if (reconnectAttempts >= MAX_RECONNECT) { connectionStatus.value = '连接已断开'; return }

  reconnectAttempts++
  connectionStatus.value = '正在重连...'
  const newToken = await refreshAccessToken()
  if (newToken) {
    reconnectAttempts = 0
    connectionStatus.value = '已连接'
    connectWebSocket()  // connectWebSocket 会读取 sessionStorage 里的新 token
  } else {
    connectionStatus.value = '连接已断开'
  }
}

function sendMessage() {
  if (!socket || socket.readyState !== WebSocket.OPEN || !msgInput.value) return
  const text = msgInput.value.value.trim()
  if (!text) return
  if (currentRoom.value.type === 'group') {
    socket.send(JSON.stringify({ type: 'group', groupId: currentRoom.value.id, content: text }))
  } else {
    socket.send(JSON.stringify({ type: 'private', to: currentRoom.value.id, content: text }))
  }
  msgInput.value.value = ''
}

function autoResize() {
  const el = msgInput.value
  if (!el) return
  el.style.height = 'auto'
  el.style.height = Math.min(el.scrollHeight, 72) + 'px'
}

function switchTab(tab) {
  activeTab.value = tab
  if (tab === 'privates') { loadFriends(); loadPending() }
}

function switchToRoom(type, id, name) {
  currentRoom.value = { type, id, name }
  historyDone.value = false
  if (type === 'group') {
    loadAnnouncement(id)
    loadHistory(id)
  } else {
    loadPrivateHistory(id)
  }
}

async function loadPrivateHistory(targetUserId) {
  try {
    const myId = publicId?.value || userId?.value || ''
    const ids = [myId, targetUserId].sort()
    const roomId = 'private_' + ids[0] + '_' + ids[1]
    const res = await getGroupHistory(roomId)
    if (res.data.length > 0) addPrivateMessages(res.data)
  } catch (e) {}
}

function addPrivateMessages(data) {
  const msgs = data.map(m => ({
    id: (m.SenderId || '') + '_' + (m.Timestamp || Date.now()),
    backendId: m.Id,
    type: 'private', senderId: m.SenderId, targetId: m.TargetUserId,
    senderNickname: m.SenderNickname, content: m.Content,
    time: formatTime(m.Timestamp),
    avatarUrl: resolveUrl(m.AvatarUrl),
    mediaUrl: resolveUrl(m.MediaUrl),
    mediaThumbUrl: resolveUrl(m.MediaThumbUrl) || resolveUrl(m.MediaUrl),
    mediaName: m.MediaName,
    mediaSize: m.MediaSize,
    isSelf: String(m.SenderId) === (publicId?.value || userId?.value || '')
  }))
  const existingIds = new Set(messages.value.map(m => m.id))
  const newOnes = msgs.filter(m => !existingIds.has(m.id))
  messages.value = [...newOnes, ...messages.value]
}

const historyLoading = ref(false)
const historyDone = ref(false)

async function loadHistory(groupId, before = null) {
  if (historyLoading.value) return
  historyLoading.value = true
  console.log('[HISTORY] 请求历史 groupId=', groupId, 'before=', before)
  try {
    const res = await getGroupHistory(groupId, 100, before)
    console.log('[HISTORY] 收到', res.data.length, '条消息')
    const historyMessages = res.data.map(m => ({
      id: (m.SenderId || 'sys') + '_' + (m.Timestamp || Date.now()),
      backendId: m.Id,
      type: 'group', senderId: m.SenderId, senderNickname: m.SenderNickname,
      content: m.Content, roomId: m.TargetUserId || groupId, time: formatTime(m.Timestamp),
      rawTimestamp: m.Timestamp,
      avatarUrl: resolveUrl(m.AvatarUrl),
      mediaUrl: resolveUrl(m.MediaUrl),
      mediaThumbUrl: resolveUrl(m.MediaThumbUrl) || resolveUrl(m.MediaUrl),
      mediaName: m.MediaName,
      mediaSize: m.MediaSize,
      isSelf: String(m.SenderId) === (publicId?.value || userId?.value || '')
    }))
    if (historyMessages.length < 100) historyDone.value = true
    const existingIds = new Set(messages.value.map(m => m.id))
    const newOnes = historyMessages.filter(m => !existingIds.has(m.id))
    console.log('[HISTORY] 去重后新增', newOnes.length, '条，总共', messages.value.length + newOnes.length)
    if (before) {
      messages.value = [...newOnes, ...messages.value]
    } else {
      messages.value = [...newOnes]
    }
  } catch (e) {
    console.error('[HISTORY] 请求失败', e)
  } finally { historyLoading.value = false }
}

/** 滚动到顶部时加载更多 */
function onMessageScroll() {
  const el = messageList.value
  if (!el || historyLoading.value || historyDone.value) return
  if (el.scrollTop <= 10) {
    const oldest = [...messages.value].reverse().find(m => m.type === 'group' && m.rawTimestamp)
    console.log('[SCROLL] 触发翻页, scrollTop=', el.scrollTop, 'oldest=', oldest?.rawTimestamp)
    if (oldest) {
      loadHistory(currentRoom.value.id, oldest.rawTimestamp)
    }
  }
}

function logout() {
  reconnectAttempts = 99 // 阻止 onclose 触发自动重连
  if (socket) socket.close()
  sessionStorage.removeItem('token')
  sessionStorage.removeItem('refreshToken')
  sessionStorage.removeItem('publicId')
  sessionStorage.removeItem('isAdmin')
  sessionStorage.removeItem('nickname')
  sessionStorage.removeItem('avatarUrl')
  router.push('/login')
}

async function loadFriends() {
  try {
    const res = await getFriends()
    privateList.value = res.data.map(f => ({ id: f.FriendId, name: f.Nickname, online: f.Online }))
  } catch (e) {}
}

async function loadPending() {
  try {
    const res = await getPendingRequests()
    pendingRequests.value = res.data
  } catch (e) {}
}

async function doSearch() {
  if (!searchQuery.value.trim()) return
  try { const res = await searchUsers(searchQuery.value); searchResults.value = res.data } catch (e) {}
}

async function doSendRequest(addresseeId) {
  try { await sendFriendRequest(addresseeId); closeAddFriend() }
  catch (e) { if (e.response?.data) alert(typeof e.response.data === 'string' ? e.response.data : e.response.data.message) }
}

function closeAddFriend() { showAddFriend.value = false; searchQuery.value = ''; searchResults.value = [] }

async function doAccept(id) {
  try { await acceptFriendRequest(id); loadPending(); loadFriends() } catch (e) {}
}
async function doReject(id) {
  try { await rejectFriendRequest(id); loadPending() } catch (e) {}
}

// ====== 群组相关 ======

async function loadGroups() {
  try {
    const res = await getMyGroups()
    groupList.value = res.data.map(g => ({ id: g.Id, name: g.Name, myRole: g.MyRole }))
  } catch (e) {}
}

async function doCreateGroup() {
  if (!newGroupName.value.trim()) return
  try {
    await createGroup(newGroupName.value.trim())
    showCreateGroup.value = false
    newGroupName.value = ''
    await loadGroups()
  } catch (e) {}
}

async function doJoinSearch() {
  if (!joinSearchQuery.value.trim()) return
  try {
    const res = await searchGroups(joinSearchQuery.value)
    joinSearchResults.value = res.data
  } catch (e) {}
}

async function doJoinGroup(groupId) {
  try {
    await joinGroup(groupId)
    showJoinGroup.value = false
    joinSearchResults.value = []
    joinSearchQuery.value = ''
    await loadGroups()
  } catch (e) {
    if (e.response?.data) alert(typeof e.response.data === 'string' ? e.response.data : e.response.data.message)
  }
}

async function loadAnnouncement(groupId) {
  try {
    const res = await getAnnouncement(groupId)
    announcement.value = res.data.Announcement || ''
    showAnnouncement.value = !!announcement.value
  } catch (e) { announcement.value = ''; showAnnouncement.value = false }
}

const announcementContent = ref('')
const historyCountSetting = ref(50)
const groupNameEdit = ref('')

async function doChangeGroupName() {
  if (!groupNameEdit.value.trim()) return
  try {
    await changeGroupName(currentRoom.value.id, groupNameEdit.value.trim())
    currentRoom.value.name = groupNameEdit.value.trim()
    await loadGroups()
  } catch (e) { alert('修改失败') }
}

async function doSetAnnouncement() {
  try {
    await setAnnouncement(currentRoom.value.id, announcementContent.value)
    await updateGroupSettings(currentRoom.value.id, { AllowMemberEditName: false, HistoryMessageCount: historyCountSetting.value })
    announcement.value = announcementContent.value
    showAnnouncement.value = !!announcement.value
    showSettingsPanel.value = false
  } catch (e) { alert('仅群主/管理员可发布公告及修改设置') }
}

async function loadMembers() {
  try {
    const res = await getGroupMembers(currentRoom.value.id)
    memberList.value = res.data
    showMembers.value = true
  } catch (e) {}
}

/** 当前群中我的角色（0=Owner, 1=Admin, 2=Member） */
const myGroupRole = computed(() => {
  const g = groupList.value.find(g => g.id === currentRoom.value.id)
  return g?.myRole ?? 2
})

async function doKick(targetUserId) {
  if (!confirm('确定要移除该成员吗？')) return
  try {
    await removeMember(currentRoom.value.id, targetUserId)
    await loadMembers()  // 刷新成员列表
  } catch (e) { alert('移除失败') }
}

async function doPromote(targetUserId, role) {
  try {
    await changeRole(currentRoom.value.id, targetUserId, role)
    await loadMembers()
  } catch (e) { alert('操作失败') }
}

// ====== 个人信息设置 ======

function openSettings() {
  settingsTab.value = 'nickname'
  newNickname.value = ''
  newEmail.value = ''
  oldPwd.value = ''
  newPwd.value = ''
  confirmPwd.value = ''
  settingsMsg.value = ''
  settingsError.value = ''
  showSettings.value = true
}

async function doChangeNickname() {
  settingsError.value = ''; settingsMsg.value = ''
  if (!newNickname.value.trim()) { settingsError.value = '请输入新昵称'; return }
  settingsLoading.value = true
  try {
    const res = await changeNickname(newNickname.value.trim())
    settingsMsg.value = res.data.Message || res.data.message
    sessionStorage.setItem('nickname', newNickname.value.trim())
    nickname.value = newNickname.value.trim()
  } catch (e) {
    settingsError.value = e.response?.data?.Message || e.response?.data?.message || (typeof e.response?.data === 'string' ? e.response.data : '修改失败')
  } finally { settingsLoading.value = false }
}

async function doChangeEmail() {
  settingsError.value = ''; settingsMsg.value = ''
  if (!newEmail.value.trim()) { settingsError.value = '请输入新邮箱'; return }
  settingsLoading.value = true
  try {
    const res = await changeEmail(newEmail.value.trim())
    settingsMsg.value = res.data.Message || res.data.message
  } catch (e) {
    settingsError.value = e.response?.data?.Message || e.response?.data?.message || (typeof e.response?.data === 'string' ? e.response.data : '修改失败')
  } finally { settingsLoading.value = false }
}

async function doChangePassword() {
  settingsError.value = ''; settingsMsg.value = ''
  if (!oldPwd.value || !newPwd.value) { settingsError.value = '请填写所有密码字段'; return }
  if (newPwd.value.length < 8) { settingsError.value = '新密码长度不能少于8个字符'; return }
  if (newPwd.value !== confirmPwd.value) { settingsError.value = '两次新密码输入不一致'; return }
  settingsLoading.value = true
  try {
    const res = await changePassword(oldPwd.value, newPwd.value)
    settingsMsg.value = res.data.Message || res.data.message
    oldPwd.value = ''; newPwd.value = ''; confirmPwd.value = ''
  } catch (e) {
    settingsError.value = e.response?.data?.Message || e.response?.data?.message || (typeof e.response?.data === 'string' ? e.response.data : '修改失败')
  } finally { settingsLoading.value = false }
}

onMounted(() => { connectWebSocket(); loadMyAvatar(); loadFriends(); loadPending(); loadGroups(); loadAnnouncement('public'); loadHistory('public') })
onBeforeUnmount(() => { if (socket) socket.close() })

// ====== 管理员功能 ======

async function loadAdminUsers() {
  try {
    const res = await getAdminUsers()
    adminUsers.value = res.data
  } catch (e) {}
}

async function loadAdminGroups() {
  try {
    const res = await getAdminGroups()
    adminGroups.value = res.data
  } catch (e) {}
}

async function doDeleteUser(userId) {
  if (!confirm('确定要删除该用户吗？此操作不可撤销！')) return
  try {
    await deleteUser(userId)
    await loadAdminUsers()
  } catch (e) { alert('删除失败') }
}

async function doDeleteGroup(groupId) {
  if (!confirm('确定要删除该群组吗？此操作不可撤销！')) return
  try {
    await deleteGroup(groupId)
    await loadAdminGroups()
  } catch (e) { alert('删除失败') }
}

async function doResetPassword(userId) {
  if (!confirm('确定要重置该用户的密码吗？')) return
  try {
    const res = await resetUserPassword(userId)
    alert('密码已重置\n用户：' + res.data.nickname + '\n新密码：' + res.data.newPassword)
  } catch (e) { alert('重置失败') }
}

async function doSetGlobalAnnouncement() {
  if (!adminAnnContent.value.trim()) return
  try {
    await setGlobalAnnouncement(adminAnnContent.value)
    adminAnnContent.value = ''
    alert('全服公告已发布')
  } catch (e) { alert('发布失败') }
}

function openAdminPanel() {
  showAdminPanel.value = true
  adminTab.value = 'users'
  loadAdminUsers()
  loadAdminGroups()
}
</script>

<template>
  <div class="chat-page">
    <aside class="sidebar">
      <div class="sidebar-header">
        <div class="user-avatar">
          <img v-if="myAvatarUrl" :src="myAvatarUrl" alt="" class="avatar-img" />
          <span v-else>{{ nickname.charAt(0) || '?' }}</span>
        </div>
        <div class="user-detail">
          <span class="user-name">{{ nickname }}</span>
          <span class="user-status" :class="{ online: connectionStatus === '已连接' }">
            {{ connectionStatus === '已连接' ? '在线' : connectionStatus }}
          </span>
        </div>
        <button class="icon-btn" title="个人信息设置" @click="openSettings">⚙</button>
        <button v-if="isAdmin" class="icon-btn admin-btn" title="管理员面板" @click="openAdminPanel">⚡</button>
        <button class="icon-btn" title="退出登录" @click="logout">⏻</button>
      </div>
      <div class="search-box"><input placeholder="搜索聊天对象..." disabled /></div>
      <div class="tab-bar">
        <button :class="{ active: activeTab === 'groups' }" @click="switchTab('groups')">📢 群组</button>
        <button :class="{ active: activeTab === 'privates' }" @click="switchTab('privates')">💬 私信</button>
      </div>

      <div v-show="activeTab === 'groups'" class="room-list">
        <div v-for="group in groupList" :key="group.id"
          class="room-item" :class="{ active: currentRoom.type === 'group' && currentRoom.id === group.id }"
          @click="switchToRoom('group', group.id, group.name)">
          <div class="room-avatar">#</div>
          <div class="room-info"><span class="room-name">{{ group.name }}</span></div>
        </div>
        <div v-if="!isAdmin" class="room-item add-room" @click="showCreateGroup = true">
          <div class="room-avatar add-icon">+</div><span class="room-name">创建新群聊</span>
        </div>
        <div v-if="!isAdmin" class="room-item add-room" @click="showJoinGroup = true">
          <div class="room-avatar add-icon">🔍</div><span class="room-name">加入群组</span>
        </div>
      </div>

      <div v-show="activeTab === 'privates'" class="room-list">
        <div v-if="!isAdmin && pendingRequests.length > 0" class="pending-bar" @click="showPendingPanel = !showPendingPanel">
          📩 {{ pendingRequests.length }} 条好友申请
        </div>
        <div v-if="showPendingPanel && pendingRequests.length > 0" class="pending-panel">
          <div v-for="req in pendingRequests" :key="req.Id" class="pending-item">
            <span>{{ req.RequesterNickname }}</span>
            <div class="pending-actions">
              <button class="btn-accept" @click="doAccept(req.Id)">接受</button>
              <button class="btn-reject" @click="doReject(req.Id)">拒绝</button>
            </div>
          </div>
        </div>
        <p v-if="privateList.length === 0 && pendingRequests.length === 0" class="empty-hint">暂无好友</p>
        <div v-for="chat in privateList" :key="chat.id"
          class="room-item" :class="{ active: currentRoom.type === 'private' && currentRoom.id === chat.id }"
          @click="switchToRoom('private', chat.id, chat.name)">
          <div class="room-avatar private-avatar" :style="{ background: chat.online ? '#4caf50' : '#888' }">{{ chat.name.charAt(0) }}</div>
          <div class="room-info">
            <span class="room-name">{{ chat.name }}</span>
            <span class="room-status" :class="{ online: chat.online }">{{ chat.online ? '在线' : '离线' }}</span>
          </div>
        </div>
        <div v-if="!isAdmin" class="room-item add-room" @click="showAddFriend = true">
          <div class="room-avatar add-icon">+</div><span class="room-name">添加好友</span>
        </div>
      </div>

      <div class="sidebar-footer"><router-link to="/" class="footer-link">← 返回首页</router-link></div>
    </aside>

    <div class="main-area">
      <header class="top-toolbar">
        <h3 class="room-title">{{ roomTitle }}</h3>
        <div class="toolbar-actions">
          <button v-if="currentRoom.type === 'group'" class="tool-btn" @click="showSettingsPanel = true; settingsPanelTab = currentRoom.id === 'public' ? 'announcement' : 'members'; loadMembers()">⚙</button>
        </div>
      </header>

      <!-- 公告横幅 -->
      <div v-if="showAnnouncement && currentRoom.type === 'group'" class="announce-bar">
        📢 {{ announcement }}
        <button @click="showAnnouncement = false">✕</button>
      </div>

      <div ref="messageList" class="message-list" @scroll="onMessageScroll">
        <p v-if="filteredMessages.length === 0" class="hint">暂无消息，开始聊天吧！</p>

        <div v-for="(msg, index) in filteredMessages" :key="index"
          class="message-row" :class="{ 'self-row': msg.isSelf, 'other-row': !msg.isSelf, 'system-row': msg.type === 'system' }">

          <!-- 系统消息居中 -->
          <template v-if="msg.type === 'system'">
            <div class="system-msg">{{ msg.content }}</div>
          </template>

          <template v-else-if="!msg.isSelf">
            <div class="avatar">
              <img v-if="msg.avatarUrl" :src="msg.avatarUrl" alt="" class="avatar-img" />
              <span v-else>{{ msg.senderNickname?.charAt(0) || '?' }}</span>
            </div>
            <div class="bubble-wrapper">
              <div class="sender-name">{{ msg.senderNickname }}</div>
              <div class="bubble other-bubble" @contextmenu.prevent="openContextMenu($event, msg)">
                <div v-if="msg.recalled" class="bubble-text">[消息已被撤回]</div>
                <img v-else-if="msg.mediaUrl" :src="msg.mediaThumbUrl || msg.mediaUrl" class="chat-image" @click="previewImage = msg.mediaUrl" alt="图片" />
                <div v-else class="bubble-text">{{ msg.content }}</div>
              </div>
              <div class="bubble-time">{{ msg.time }}</div>
            </div>
          </template>

          <template v-else>
            <div class="avatar self-avatar">
              <img v-if="myAvatarUrl" :src="myAvatarUrl" alt="" class="avatar-img" />
              <span v-else>{{ nickname.charAt(0) || '我' }}</span>
            </div>
            <div class="bubble-wrapper right">
              <div class="bubble self-bubble" @contextmenu.prevent="openContextMenu($event, msg)">
                <div v-if="msg.recalled" class="bubble-text">[消息已被撤回]</div>
                <img v-else-if="msg.mediaUrl" :src="msg.mediaThumbUrl || msg.mediaUrl" class="chat-image" @click="previewImage = msg.mediaUrl" alt="图片" />
                <div v-else class="bubble-text">{{ msg.content }}</div>
              </div>
              <div class="bubble-time right">{{ msg.time }}</div>
            </div>
          </template>

          <!-- 消息右键菜单 -->
          <div v-if="contextMenuMsg && contextMenuMsg.id === msg.id" class="context-menu" :style="{ left: contextMenuPos.x + 'px', top: contextMenuPos.y + 'px' }">
            <button @click="doRecall(msg)">撤回</button>
          </div>
        </div>
      </div>

      <div class="input-toolbar">
        <button class="tool-icon-btn" title="发送图片" @click="triggerImageInput">🖼</button>
        <input ref="imageFileInput" type="file" accept="image/jpeg,image/png,image/gif,image/webp"
          style="display:none" @change="onImageSelected" />
        <!-- 图片上传进度条 -->
        <div v-if="uploading" class="upload-bar">
          <div class="upload-progress" :style="{ width: uploadProgress + '%' }"></div>
          <span class="upload-text">{{ uploadFileName }} · {{ Math.round(uploadProgress) }}%</span>
        </div>
        <button v-if="uploading" class="tool-icon-btn" title="取消上传" @click="cancelUpload">✕</button>
      </div>

      <div class="chat-box">
        <textarea ref="msgInput" placeholder="输入消息... (Enter 发送, Shift+Enter 换行)"
          rows="1" @keydown.enter.exact.prevent="sendMessage" @input="autoResize"></textarea>
        <button @click="sendMessage">发送</button>
      </div>
    </div>

    <!-- 图片查看大图弹窗 -->
    <div v-if="previewImage" class="modal-overlay" @click.self="previewImage = null">
      <div class="image-preview-box">
        <img :src="previewImage" alt="图片预览" />
        <button class="modal-close" @click="previewImage = null">关闭</button>
      </div>
    </div>

    <div v-if="showAddFriend" class="modal-overlay" @click.self="closeAddFriend">
      <div class="modal-box">
        <h3>添加好友</h3>
        <div class="search-row">
          <input v-model="searchQuery" placeholder="输入昵称搜索..." @keyup.enter="doSearch" />
          <button @click="doSearch">搜索</button>
        </div>
        <div v-if="searchResults.length > 0" class="search-results">
          <div v-for="u in searchResults" :key="u.Id" class="search-item">
            <span>{{ u.Nickname }} <i v-if="u.Online" class="online-tag">在线</i></span>
            <button @click="doSendRequest(u.PublicId)" :disabled="u.PublicId === publicId">
              {{ u.PublicId === publicId ? '自己' : '加好友' }}
            </button>
          </div>
        </div>
        <button class="modal-close" @click="closeAddFriend">关闭</button>
      </div>
    </div>

    <!-- ====== 个人信息设置弹窗 ====== -->
    <div v-if="showSettings" class="modal-overlay" @click.self="showSettings = false">
      <div class="modal-box settings-box">
        <h3>个人信息设置</h3>
        <div class="settings-tabs">
          <button :class="{ active: settingsTab === 'avatar' }" @click="settingsTab = 'avatar'">头像</button>
          <button :class="{ active: settingsTab === 'nickname' }" @click="settingsTab = 'nickname'">昵称</button>
          <button :class="{ active: settingsTab === 'email' }" @click="settingsTab = 'email'">邮箱</button>
          <button :class="{ active: settingsTab === 'password' }" @click="settingsTab = 'password'">密码</button>
        </div>

        <!-- 修改头像 -->
        <div v-show="settingsTab === 'avatar'" class="settings-form">
          <div class="avatar-preview">
            <img v-if="myAvatarUrl" :src="myAvatarUrl" alt="当前头像" class="avatar-preview-img" />
            <span v-else class="avatar-preview-letter">{{ nickname.charAt(0) || '?' }}</span>
          </div>
          <input ref="avatarFileInput" type="file" accept="image/jpeg,image/png,image/gif,image/webp"
            style="display:none" @change="onAvatarSelected" />
          <button class="settings-btn" @click="triggerAvatarInput" :disabled="settingsLoading">选择图片上传</button>
          <button v-if="myAvatarUrl" class="settings-btn" style="background:#e74c3c" @click="doRemoveAvatar" :disabled="settingsLoading">恢复默认头像</button>
          <p style="font-size:12px;color:#999;margin:0">支持 jpg / png / gif / webp，大小不超过 3MB</p>
        </div>

        <!-- 修改昵称 -->
        <div v-show="settingsTab === 'nickname'" class="settings-form">
          <input v-model="newNickname" placeholder="输入新昵称" />
          <button class="settings-btn" @click="doChangeNickname" :disabled="settingsLoading">确认修改</button>
        </div>

        <!-- 修改邮箱 -->
        <div v-show="settingsTab === 'email'" class="settings-form">
          <input v-model="newEmail" type="email" placeholder="输入新邮箱" />
          <button class="settings-btn" @click="doChangeEmail" :disabled="settingsLoading">确认修改</button>
        </div>

        <!-- 修改密码 -->
        <div v-show="settingsTab === 'password'" class="settings-form">
          <input v-model="oldPwd" type="password" placeholder="当前密码" />
          <input v-model="newPwd" type="password" placeholder="新密码（至少8位）" />
          <input v-model="confirmPwd" type="password" placeholder="确认新密码" />
          <button class="settings-btn" @click="doChangePassword" :disabled="settingsLoading">确认修改</button>
        </div>

        <p v-if="settingsError" class="settings-error">{{ settingsError }}</p>
        <p v-if="settingsMsg" class="settings-success">{{ settingsMsg }}</p>

        <button class="modal-close" @click="showSettings = false">关闭</button>
      </div>
    </div>

    <!-- 创建群组弹窗 -->
    <div v-if="showCreateGroup" class="modal-overlay" @click.self="showCreateGroup = false">
      <div class="modal-box">
        <h3>创建新群聊</h3>
        <input v-model="newGroupName" placeholder="输入群名称" @keyup.enter="doCreateGroup" style="padding:10px 12px;border:1px solid #ddd;border-radius:6px;font-size:14px;outline:none" />
        <button class="settings-btn" @click="doCreateGroup">创建</button>
        <button class="modal-close" @click="showCreateGroup = false">取消</button>
      </div>
    </div>

    <!-- 加入群组弹窗 -->
    <div v-if="showJoinGroup" class="modal-overlay" @click.self="showJoinGroup = false">
      <div class="modal-box">
        <h3>加入群组</h3>
        <div class="search-row">
          <input v-model="joinSearchQuery" placeholder="搜索群名称..." @keyup.enter="doJoinSearch" />
          <button @click="doJoinSearch">搜索</button>
        </div>
        <div v-if="joinSearchResults.length > 0" class="search-results">
          <div v-for="g in joinSearchResults" :key="g.Id" class="search-item">
            <span>{{ g.Name }} ({{ g.MemberCount }}人)</span>
            <button @click="doJoinGroup(g.Id)">加入</button>
          </div>
        </div>
        <button class="modal-close" @click="showJoinGroup = false">关闭</button>
      </div>
    </div>

    <!-- ====== 右侧设置面板 ====== -->
    <div v-if="showSettingsPanel && currentRoom.type === 'group'" class="settings-overlay" @click.self="showSettingsPanel = false">
      <div class="settings-panel">
        <h3>群设置 — {{ roomTitle }}</h3>
        <div class="settings-tabs">
          <button v-if="currentRoom.id !== 'public'" :class="{ active: settingsPanelTab === 'members' }" @click="settingsPanelTab = 'members'; loadMembers()">成员</button>
          <button :class="{ active: settingsPanelTab === 'announcement' }" @click="settingsPanelTab = 'announcement'; announcementContent = announcement.value">公告</button>
          <button v-if="currentRoom.id !== 'public'" :class="{ active: settingsPanelTab === 'config' }" @click="settingsPanelTab = 'config'">配置</button>
        </div>

        <!-- 成员列表 -->
        <div v-show="settingsPanelTab === 'members'" class="panel-scroll">
          <div v-for="m in memberList" :key="m.UserId" class="member-row">
            <span>{{ m.Nickname }} <i v-if="m.Online" class="online-tag">在线</i>
              <span style="color:#888;font-size:11px">{{ m.Role===0?'群主':m.Role===1?'管理':'成员' }} {{ m.IsMuted ? '🤫' : '' }}</span>
            </span>
            <div v-if="(myGroupRole <= 1 || isAdmin) && m.UserId !== publicId" class="member-actions">
              <button v-if="myGroupRole === 0 && m.Role === 2" class="btn-accept" @click="doPromote(m.UserId, 1)">升管理</button>
              <button v-if="myGroupRole === 0 && m.Role === 1" class="btn-reject" @click="doPromote(m.UserId, 2)">降成员</button>
              <button v-if="!m.IsMuted" class="btn-accept" @click="doMute(m.UserId)">禁言</button>
              <button v-else class="btn-reject" @click="doUnmute(m.UserId)">解禁</button>
              <button v-if="m.Role !== 0" class="btn-reject" @click="doKick(m.UserId)">踢出</button>
            </div>
          </div>
        </div>

        <!-- 公告 -->
        <div v-show="settingsPanelTab === 'announcement'" class="settings-form">
          <textarea v-model="announcementContent" placeholder="输入群公告内容..." rows="4"
            style="padding:10px 12px;border:1px solid #ddd;border-radius:6px;font-size:14px;outline:none;resize:vertical;font-family:inherit"></textarea>
          <button class="settings-btn" @click="doSetAnnouncement">发布公告</button>
        </div>

        <!-- 配置 -->
        <div v-show="settingsPanelTab === 'config'" class="panel-scroll">
          <div class="settings-form">
            <label style="font-size:13px;color:#555">群名称</label>
            <div style="display:flex;gap:8px">
              <input v-model="groupNameEdit" :placeholder="roomTitle" style="flex:1" />
              <button class="settings-btn" @click="doChangeGroupName" style="width:auto;padding:10px 16px">修改</button>
            </div>
          </div>
          <div class="settings-form" style="margin-top:16px">
            <label style="font-size:13px;color:#555">新成员可见历史消息数（0=不可见）</label>
            <input v-model.number="historyCountSetting" type="number" min="0" max="200" />
          </div>
        </div>

        <button class="modal-close" @click="showSettingsPanel = false; showAnnouncementEdit = false" style="margin-top:auto">关闭</button>
      </div>
    </div>

    <!-- ====== 管理员面板 ====== -->
    <div v-if="showAdminPanel" class="modal-overlay" @click.self="showAdminPanel = false">
      <div class="modal-box settings-box" style="width:520px">
        <h3>⚡ 管理员面板</h3>
        <div class="settings-tabs">
          <button :class="{ active: adminTab === 'users' }" @click="adminTab = 'users'; loadAdminUsers()">用户</button>
          <button :class="{ active: adminTab === 'groups' }" @click="adminTab = 'groups'; loadAdminGroups()">群组</button>
          <button :class="{ active: adminTab === 'announcement' }" @click="adminTab = 'announcement'">公告</button>
        </div>

        <!-- 用户管理 -->
        <div v-show="adminTab === 'users'" class="panel-scroll" style="max-height:45vh;overflow-y:auto">
          <div v-for="u in adminUsers" :key="u.PublicId" class="member-row">
            <span>{{ u.Nickname }} ({{ u.Email }}) <i v-if="u.IsAdmin" style="color:#e67e22">管理员</i></span>
            <div class="member-actions">
              <button v-if="!u.IsAdmin" class="btn-accept" @click="doResetPassword(u.PublicId)" style="padding:3px 10px">重置密码</button>
              <button v-if="!u.IsAdmin" class="btn-reject" @click="doDeleteUser(u.PublicId)" style="padding:3px 10px">删除</button>
            </div>
          </div>
          <p v-if="adminUsers.length === 0" class="hint" style="padding:20px 0">加载中...</p>
        </div>

        <!-- 群组管理 -->
        <div v-show="adminTab === 'groups'" class="panel-scroll" style="max-height:45vh;overflow-y:auto">
          <div v-for="g in adminGroups" :key="g.Id" class="member-row">
            <span>{{ g.Name }} <span style="color:#888;font-size:11px">({{ g.MemberCount }}人)</span></span>
            <button v-if="g.Id !== 'public'" class="btn-reject" @click="doDeleteGroup(g.Id)" style="padding:3px 10px">删除</button>
          </div>
          <p v-if="adminGroups.length === 0" class="hint" style="padding:20px 0">加载中...</p>
        </div>

        <!-- 全服公告 -->
        <div v-show="adminTab === 'announcement'" class="settings-form">
          <textarea v-model="adminAnnContent" placeholder="输入全服公告内容..." rows="4"
            style="padding:10px 12px;border:1px solid #ddd;border-radius:6px;font-size:14px;outline:none;resize:vertical;font-family:inherit"></textarea>
          <button class="settings-btn" @click="doSetGlobalAnnouncement">发布公告</button>
        </div>

        <button class="modal-close" @click="showAdminPanel = false">关闭</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.chat-page { display: flex; height: 100vh; background: #f0f2f5; font-family: "Microsoft YaHei","PingFang SC",Arial,sans-serif; overflow: hidden; }
.sidebar { width: 280px; min-width: 280px; background: #2e2e3a; color: #ccc; display: flex; flex-direction: column; border-right: 1px solid #1e1e28; }
.sidebar-header { display: flex; align-items: center; gap: 12px; padding: 16px; background: #252532; }
.user-avatar { width: 40px; height: 40px; border-radius: 50%; background: #667eea; color: white; display: flex; align-items: center; justify-content: center; font-size: 16px; font-weight: bold; flex-shrink: 0; overflow: hidden; }
.avatar-img { width: 100%; height: 100%; object-fit: cover; display: block; }
.avatar-preview { width: 96px; height: 96px; border-radius: 50%; background: #667eea; color: white; display: flex; align-items: center; justify-content: center; font-size: 40px; font-weight: bold; overflow: hidden; align-self: center; }
.avatar-preview-img { width: 100%; height: 100%; object-fit: cover; }
.avatar-preview-letter { font-size: 40px; }
.user-detail { flex: 1; display: flex; flex-direction: column; min-width: 0; }
.user-name { color: #fff; font-size: 15px; font-weight: 600; }
.user-status { font-size: 12px; color: #888; }
.user-status.online { color: #4caf50; }
.icon-btn { background: none; border: none; color: #999; font-size: 18px; cursor: pointer; padding: 4px; }
.icon-btn:hover { color: #e74c3c; }
.admin-btn { color: #f0a500; }
.admin-btn:hover { color: #e67e22; }
.search-box { padding: 12px 16px; }
.search-box input { width: 100%; padding: 8px 12px; background: #1e1e28; border: none; border-radius: 4px; color: #ccc; font-size: 13px; outline: none; box-sizing: border-box; }
.tab-bar { display: flex; padding: 0 16px; gap: 4px; margin-bottom: 8px; }
.tab-bar button { flex: 1; padding: 8px 0; background: none; border: none; color: #999; font-size: 13px; cursor: pointer; border-bottom: 2px solid transparent; transition: all 0.2s; }
.tab-bar button.active { color: #667eea; border-bottom-color: #667eea; }
.room-list { flex: 1; overflow-y: auto; padding: 4px 8px; }
.room-item { display: flex; align-items: center; gap: 10px; padding: 10px 12px; border-radius: 6px; cursor: pointer; transition: background 0.15s; }
.room-item:hover { background: #3a3a4a; }
.room-item.active { background: #4a4a5e; color: #fff; }
.room-avatar { width: 36px; height: 36px; border-radius: 6px; background: #555; color: #ccc; display: flex; align-items: center; justify-content: center; font-size: 16px; font-weight: bold; flex-shrink: 0; }
.private-avatar { border-radius: 50%; background: #667eea; color: white; }
.add-room .add-icon { background: #3a3a4a; border: 1px dashed #666; color: #666; }
.add-room:hover .add-icon { border-color: #667eea; color: #667eea; }
.room-info { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.room-name { font-size: 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.room-status { font-size: 11px; color: #888; }
.room-status.online { color: #4caf50; }
.empty-hint { color: #666; text-align: center; padding: 40px 0; font-size: 13px; }
.sidebar-footer { padding: 12px 16px; border-top: 1px solid #1e1e28; }
.footer-link { color: #888; text-decoration: none; font-size: 12px; }
.footer-link:hover { color: #667eea; }

.main-area { flex: 1; display: flex; flex-direction: column; min-width: 0; background: #f5f5f5; }
.top-toolbar { display: flex; align-items: center; justify-content: space-between; padding: 0 24px; height: 56px; background: white; border-bottom: 1px solid #e8e8e8; flex-shrink: 0; }
.room-title { font-size: 16px; font-weight: 600; color: #333; margin: 0; }
.message-list { flex: 1; overflow-y: auto; padding: 16px 24px; display: flex; flex-direction: column; gap: 12px; background: #f5f5f5; }
.hint { color: #999; text-align: center; margin: auto; font-size: 14px; }
.message-row { display: flex; align-items: flex-start; gap: 8px; max-width: 75%; }
.self-row { align-self: flex-end; flex-direction: row-reverse; }
.other-row { align-self: flex-start; }
.avatar { width: 36px; height: 36px; border-radius: 50%; background: #667eea; color: white; display: flex; align-items: center; justify-content: center; font-size: 14px; font-weight: bold; flex-shrink: 0; overflow: hidden; }
.self-avatar { background: #764ba2; }
.bubble-wrapper { display: flex; flex-direction: column; gap: 2px; }
.bubble-wrapper.right { align-items: flex-end; }
.sender-name { font-size: 12px; color: #555; margin-bottom: 2px; }
.bubble { padding: 10px 14px; border-radius: 18px; word-break: break-word; line-height: 1.4; font-size: 14px; }
.bubble-text { white-space: pre-wrap; }
.self-bubble { background: #667eea; color: white; }
.other-bubble { background: white; color: #333; box-shadow: 0 1px 2px rgba(0,0,0,0.06); }
.bubble-time { font-size: 11px; color: #bbb; padding: 0 4px; }
.bubble-time.right { text-align: right; }
.input-toolbar { display: flex; gap: 4px; padding: 8px 24px 0; background: white; min-height: 32px; align-items: center; }
.tool-icon-btn { background: none; border: none; font-size: 18px; cursor: pointer; padding: 2px 6px; border-radius: 4px; }
.tool-icon-btn:hover { background: #f0f0f0; }
.upload-bar { flex: 1; display: flex; align-items: center; gap: 8px; background: #f5f5f5; border-radius: 6px; padding: 6px 10px; position: relative; overflow: hidden; }
.upload-progress { position: absolute; left: 0; top: 0; bottom: 0; background: #667eea; opacity: 0.15; transition: width 0.2s; }
.upload-text { position: relative; font-size: 12px; color: #555; }
.chat-image { max-width: 280px; max-height: 280px; border-radius: 10px; display: block; cursor: zoom-in; }
.image-preview-box { background: white; border-radius: 12px; padding: 16px; max-width: 90vw; max-height: 90vh; display: flex; flex-direction: column; gap: 12px; }
.image-preview-box img { max-width: 85vw; max-height: 80vh; object-fit: contain; border-radius: 8px; }
.chat-box { display: flex; align-items: flex-end; gap: 8px; padding: 8px 24px 16px; background: white; border-top: 1px solid #eee; }
.chat-box textarea { flex: 1; padding: 10px 16px; border: 1px solid #e0e0e0; border-radius: 12px; font-size: 14px; font-family: inherit; line-height: 1.5; outline: none; resize: none; overflow-y: auto; transition: border-color 0.2s; }
.chat-box textarea:focus { border-color: #667eea; }
.chat-box button { padding: 10px 24px; background: #667eea; color: white; border: none; border-radius: 12px; cursor: pointer; font-size: 14px; font-weight: 500; transition: background 0.2s; white-space: nowrap; flex-shrink: 0; }
.chat-box button:hover { background: #5a6fd6; }

.pending-bar { padding: 10px 14px; margin: 4px 8px; background: #fff3cd; border-radius: 6px; font-size: 13px; cursor: pointer; color: #856404; }
.pending-panel { padding: 4px 8px; }
.pending-item { display: flex; align-items: center; justify-content: space-between; padding: 8px 12px; margin: 2px 0; background: #3a3a4a; border-radius: 6px; font-size: 13px; }
.pending-actions { display: flex; gap: 6px; }
.btn-accept, .btn-reject { padding: 3px 10px; border: none; border-radius: 4px; font-size: 12px; cursor: pointer; }
.btn-accept { background: #4caf50; color: white; }
.btn-reject { background: #e74c3c; color: white; }
.online-tag { font-style: normal; font-size: 11px; color: #4caf50; }

.modal-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.5); display: flex; align-items: center; justify-content: center; z-index: 100; }
.modal-box { background: white; border-radius: 12px; padding: 24px; width: 400px; max-height: 80vh; display: flex; flex-direction: column; gap: 16px; }
.modal-box h3 { margin: 0; color: #333; }
.search-row { display: flex; gap: 8px; }
.search-row input { flex: 1; padding: 8px 12px; border: 1px solid #ddd; border-radius: 6px; font-size: 14px; outline: none; }
.search-row button { padding: 8px 16px; background: #667eea; color: white; border: none; border-radius: 6px; cursor: pointer; }
.search-results { max-height: 300px; overflow-y: auto; }
.search-item { display: flex; align-items: center; justify-content: space-between; padding: 10px 0; border-bottom: 1px solid #eee; color: #333; }
.search-item button { padding: 5px 14px; background: #667eea; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 13px; }
.search-item button:disabled { background: #ccc; cursor: not-allowed; }
.modal-close { align-self: flex-end; padding: 6px 16px; background: #eee; border: none; border-radius: 6px; cursor: pointer; font-size: 13px; }

/* ====== 设置弹窗 ====== */
.settings-box { width: 420px; }
.settings-tabs { display: flex; gap: 0; border-bottom: 2px solid #eee; }
.settings-tabs button {
  flex: 1; padding: 10px 0; background: none; border: none;
  font-size: 14px; cursor: pointer; color: #888;
  border-bottom: 2px solid transparent; margin-bottom: -2px; transition: all 0.2s;
}
.settings-tabs button.active { color: #667eea; border-bottom-color: #667eea; }
.settings-form { display: flex; flex-direction: column; gap: 12px; }
.settings-form input {
  padding: 10px 12px; border: 1px solid #ddd; border-radius: 6px;
  font-size: 14px; outline: none;
}
.settings-form input:focus { border-color: #667eea; }
.settings-btn {
  padding: 10px 0; background: #667eea; color: white; border: none;
  border-radius: 6px; cursor: pointer; font-size: 14px; transition: background 0.2s;
}
.settings-btn:hover { background: #5a6fd6; }
.settings-btn:disabled { opacity: 0.6; cursor: not-allowed; }
.settings-error { color: #e74c3c; font-size: 13px; margin: 0; }
.settings-success { color: #27ae60; font-size: 13px; margin: 0; }

/* ====== 公告横幅 ====== */
.announce-bar {
  display: flex; align-items: center; gap: 10px;
  padding: 10px 24px; background: #fff3cd; color: #856404;
  font-size: 13px; border-bottom: 1px solid #ffeeba;
}
.announce-bar button {
  margin-left: auto; background: none; border: none; color: #856404;
  cursor: pointer; font-size: 16px;
}

/* ====== 系统消息 ====== */
.system-row { max-width: 100% !important; justify-content: center; }
.system-msg {
  text-align: center; font-size: 12px; color: #999;
  background: transparent; padding: 4px 12px;
}

/* ====== 右键菜单 ====== */
.context-menu {
  position: fixed; z-index: 200; background: white;
  border-radius: 8px; box-shadow: 0 4px 16px rgba(0,0,0,0.15);
  padding: 4px 0;
}
.context-menu button {
  display: block; width: 100%; padding: 8px 20px; background: none;
  border: none; font-size: 13px; cursor: pointer; text-align: left;
}
.context-menu button:hover { background: #f5f5f5; color: #e74c3c; }

/* ====== 右侧设置面板 ====== */
.settings-overlay {
  position: fixed; inset: 0; background: rgba(0,0,0,0.3); z-index: 100;
  display: flex; justify-content: flex-end;
}
.settings-panel {
  width: 340px; background: white; display: flex; flex-direction: column;
  padding: 20px; gap: 16px; height: 100vh; overflow-y: auto;
}
.settings-panel h3 { margin: 0; color: #333; }
.panel-scroll { flex: 1; overflow-y: auto; }
.member-row {
  display: flex; align-items: center; justify-content: space-between;
  padding: 8px 0; border-bottom: 1px solid #eee;
  color: #333; font-size: 14px;
}
.member-actions { display: flex; gap: 4px; }
</style>
