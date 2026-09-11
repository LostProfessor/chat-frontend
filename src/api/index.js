import axios from 'axios'

const API_BASE_URL = 'http://localhost:5258'

const api = axios.create({
  baseURL: API_BASE_URL,
  timeout: 10000,
  headers: { 'Content-Type': 'application/json' }
})

// 请求拦截器：自动附带 JWT token
api.interceptors.request.use(config => {
  const token = sessionStorage.getItem('token')
  if (token) config.headers.Authorization = `Bearer ${token}`
  return config
})

// ====== access token 自动续期（Refresh Token 机制） ======

/** 清理登录状态并跳回登录页 */
function redirectToLogin() {
  sessionStorage.removeItem('token')
  sessionStorage.removeItem('refreshToken')
  sessionStorage.removeItem('publicId')
  sessionStorage.removeItem('isAdmin')
  sessionStorage.removeItem('nickname')
  sessionStorage.removeItem('avatarUrl')
  if (!window.location.pathname.includes('/login')) {
    window.location.href = '/login'
  }
}

// 响应拦截器：401 时用 refresh token 换新 access token，并重放原请求
api.interceptors.response.use(
  res => res,
  async error => {
    const original = error.config
    const status = error.response?.status
    const url = original?.url || ''

    // 只处理 API 请求的 401；登录/刷新接口本身返回 401 时不处理，避免死循环
    const shouldRefresh = status === 401 &&
      !url.includes('/auth/login') &&
      !url.includes('/auth/refresh') &&
      !original._retried

    if (shouldRefresh) {
      const newToken = await refreshAccessToken()
      if (newToken) {
        original._retried = true
        original.headers.Authorization = `Bearer ${newToken}`
        return api(original)  // 用新 token 重放原请求
      }
    }
    return Promise.reject(error)
  }
)

/**
 * 用 refresh token 换取新的 access token（供拦截器和 WebSocket 重连复用）。
 * 并发去重：多个调用共享同一个刷新请求，避免轮换冲突。
 * 成功返回新 token，失败则清理登录状态并返回 null。
 */
let refreshing = null

export async function refreshAccessToken() {
  if (refreshing) return refreshing

  const refreshToken = sessionStorage.getItem('refreshToken')
  if (!refreshToken) { redirectToLogin(); return null }

  refreshing = api.post('/api/auth/refresh', { refreshToken })
    .then(res => {
      sessionStorage.setItem('token', res.data.token)
      sessionStorage.setItem('refreshToken', res.data.refreshToken)
      return res.data.token
    })
    .catch(() => { redirectToLogin(); return null })
    .finally(() => { refreshing = null })

  return refreshing
}

export function register(nickname, email, password) {
  return api.post('/api/auth/register', { nickname, email, password })
}

export function login(nickname, email, password) {
  return api.post('/api/auth/login', { nickname, email, password })
}

export function createWebSocket(token) {
  return new WebSocket(`ws://localhost:5259/ws?token=${token}`)
}

// ====== 好友相关 API ======

export function searchUsers(nickname) {
  return api.get('/api/friend/search', { params: { nickname } })
}

export function sendFriendRequest(addresseeId) {
  return api.post('/api/friend/request', { addresseeId })
}

export function getFriends() {
  return api.get('/api/friend')
}

export function getPendingRequests() {
  return api.get('/api/friend/pending')
}

export function acceptFriendRequest(id) {
  return api.put(`/api/friend/${id}/accept`)
}

export function rejectFriendRequest(id) {
  return api.put(`/api/friend/${id}/reject`)
}

// ====== 用户个人信息 API ======

export function changeNickname(newNickname) {
  return api.post('/api/user/nickname', { newNickname })
}

export function changeEmail(newEmail) {
  return api.post('/api/user/email', { newEmail })
}

export function changePassword(currentPassword, newPassword) {
  return api.post('/api/user/password', { currentPassword, newPassword })
}

// ====== 头像 API ======

export function getProfile() {
  return api.get('/api/user/profile')
}

export function uploadAvatar(file) {
  const formData = new FormData()
  formData.append('file', file)
  return api.post('/api/user/avatar', formData, {
    headers: { 'Content-Type': 'multipart/form-data' }
  })
}

export function deleteAvatar() {
  return api.delete('/api/user/avatar')
}

// ====== 群组相关 API ======

export function createGroup(name) {
  return api.post('/api/group/create', { name })
}

export function getMyGroups() {
  return api.get('/api/group')
}

export function searchGroups(name) {
  return api.get('/api/group/search', { params: { name } })
}

export function joinGroup(groupId) {
  return api.post(`/api/group/${groupId}/join`)
}

export function getGroupMembers(groupId) {
  return api.get(`/api/group/${groupId}/members`)
}

export function changeGroupName(groupId, name) {
  return api.put(`/api/group/${groupId}/name`, { name })
}

export function getAnnouncement(groupId) {
  return api.get(`/api/group/${groupId}/announcement`)
}

export function setAnnouncement(groupId, content) {
  return api.put(`/api/group/${groupId}/announcement`, { content })
}

export function changeRole(groupId, userId, role) {
  return api.put(`/api/group/${groupId}/member/${userId}/role`, { role })
}

export function removeMember(groupId, userId) {
  return api.delete(`/api/group/${groupId}/member/${userId}`)
}

export function getGroupHistory(groupId, count = 100, before = null) {
  const params = { count }
  if (before) params.before = before
  return api.get(`/api/group/${groupId}/history`, { params })
}

export function updateGroupSettings(groupId, settings) {
  return api.put(`/api/group/${groupId}/settings`, settings)
}

export function recallMessage(messageId) {
  return api.put(`/api/message/${messageId}/recall`)
}

export function muteMember(groupId, userId) {
  return api.put(`/api/group/${groupId}/member/${userId}/mute`)
}

export function unmuteMember(groupId, userId) {
  return api.put(`/api/group/${groupId}/member/${userId}/unmute`)
}

// ====== 管理员 API ======

export function getAdminUsers() {
  return api.get('/api/admin/users')
}

export function deleteUser(userId) {
  return api.delete(`/api/admin/users/${userId}`)
}

export function getAdminGroups() {
  return api.get('/api/admin/groups')
}

export function deleteGroup(groupId) {
  return api.delete(`/api/admin/groups/${groupId}`)
}

export function setGlobalAnnouncement(content) {
  return api.put('/api/admin/announcement', { content })
}

export function postGlobalAnnouncement(content) {
  return api.put('/api/admin/announcement', { content })
}

export function getAdminAnnouncements() {
  return api.get('/api/admin/announcement')
}

export function getAdminStats() {
  return api.get('/api/admin/stats')
}

export function resetUserPassword(userId) {
  return api.post(`/api/admin/users/${userId}/reset-password`)
}

export default api
