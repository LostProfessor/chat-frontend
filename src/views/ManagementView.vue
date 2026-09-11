<script setup>
import { ref, onMounted, onBeforeUnmount } from 'vue'
import { useRouter } from 'vue-router'
import {
  getAdminUsers, deleteUser, getAdminGroups,
  deleteGroup, getAdminAnnouncements, postGlobalAnnouncement,
  resetUserPassword, getAdminStats
} from '../api'
import { Line } from 'vue-chartjs'
import { Dashboard, User, Peoples, Broadcast, Message, Left, Logout } from '../components/icons'
import {
  Chart as ChartJS,
  CategoryScale, LinearScale, PointElement,
  LineElement, Title, Tooltip, Legend, Filler
} from 'chart.js'

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Title, Tooltip, Legend, Filler)

const router = useRouter()

const nickname = ref(sessionStorage.getItem('nickname') || '')
const avatarUrl = ref(getStoredAvatar())
const API_BASE = import.meta.env.VITE_API_BASE_URL || 'http://localhost:5258'

function getStoredAvatar() {
  const stored = sessionStorage.getItem('avatarUrl')
  if (!stored) return null
  return stored.startsWith('/') ? API_BASE + stored : stored
}
const now = ref(new Date())
const activeTab = ref('dashboard')

// ─── 用户管理 ───
const users = ref([])
const userSearch = ref('')
const loadingUsers = ref(false)

async function loadUsers() {
  loadingUsers.value = true
  try {
    const res = await getAdminUsers(userSearch.value || undefined)
    users.value = res.data
  } catch (e) {
    alert('加载用户列表失败：' + (e.response?.data?.message || e.message))
  } finally {
    loadingUsers.value = false
  }
}

async function handleDeleteUser(publicId) {
  if (!confirm(`确定要删除该用户吗？此操作不可撤销。`)) return
  try {
    await deleteUser(publicId)
    users.value = users.value.filter(u => u.PublicId !== publicId)
  } catch (e) {
    alert('删除失败：' + (e.response?.data?.message || e.message))
  }
}

async function handleResetPassword(publicId) {
  if (!confirm('确定要重置该用户密码为 "123456" 吗？')) return
  try {
    await resetUserPassword(publicId)
    alert('密码已重置为 123456')
  } catch (e) {
    alert('重置失败：' + (e.response?.data?.message || e.message))
  }
}

// ─── 群组管理 ───
const groups = ref([])
const loadingGroups = ref(false)

async function loadGroups() {
  loadingGroups.value = true
  try {
    const res = await getAdminGroups()
    groups.value = res.data
  } catch (e) {
    alert('加载群组列表失败')
  } finally {
    loadingGroups.value = false
  }
}

async function handleDeleteGroup(groupId) {
  if (!confirm(`确定要删除该群组吗？所有群消息将被清除。`)) return
  try {
    await deleteGroup(groupId)
    groups.value = groups.value.filter(g => g.Id !== groupId)
  } catch (e) {
    alert('删除失败：' + (e.response?.data?.message || e.message))
  }
}

// ─── 系统面板 ───
const stats = ref({ totalUsers: 0, totalMessages: 0, todayNewUsers: 0, todayNewMessages: 0, dailyData: [] })
const chartData = ref({ labels: [], datasets: [] })
const chartOptions = {
  responsive: true,
  maintainAspectRatio: false,
  interaction: { intersect: false, mode: 'index' },
  plugins: { legend: { position: 'top' } },
  scales: {
    y: { beginAtZero: true, grid: { color: '#eee' } },
    x: { grid: { display: false } }
  }
}

async function loadStats() {
  try {
    const res = await getAdminStats()
    const d = res.data
    stats.value = { totalUsers: d.TotalUsers, totalMessages: d.TotalMessages, todayNewUsers: d.TodayNewUsers, todayNewMessages: d.TodayNewMessages, dailyData: d.DailyData }

    chartData.value = {
      labels: d.DailyData.map(x => x.Date),
      datasets: [
        { label: '新增用户', data: d.DailyData.map(x => x.NewUsers), borderColor: '#667eea', backgroundColor: 'rgba(102,126,234,0.1)', fill: true, tension: 0.3, pointRadius: 3 },
        { label: '新增消息', data: d.DailyData.map(x => x.NewMessages), borderColor: '#f39c12', backgroundColor: 'rgba(243,156,18,0.1)', fill: true, tension: 0.3, pointRadius: 3 }
      ]
    }
  } catch (e) { }
}

// ─── 全服公告 ───
const announcement = ref('')
const sendingAnnouncement = ref(false)
const announcementHistory = ref([])

async function loadAnnouncements() {
  try {
    const res = await getAdminAnnouncements()
    announcementHistory.value = res.data
  } catch (e) { }
}

async function handleSetAnnouncement() {
  if (!announcement.value.trim()) return
  sendingAnnouncement.value = true
  try {
    await postGlobalAnnouncement(announcement.value)
    alert('公告已发布')
    announcement.value = ''
    await loadAnnouncements()
  } catch (e) {
    alert('发布失败：' + (e.response?.data?.message || e.message))
  } finally {
    sendingAnnouncement.value = false
  }
}

function formatTime(dt) {
  if (!dt) return ''
  // 后端存 UTC，JS 需要时区标记才能正确转换
  const d = new Date(dt + (String(dt).endsWith('Z') ? '' : 'Z'))
  return d.toLocaleString('zh-CN')
}

function logout() {
  sessionStorage.removeItem('token')
  sessionStorage.removeItem('publicId')
  sessionStorage.removeItem('nickname')
  router.push('/login')
}

function switchTab(tab) {
  activeTab.value = tab
  if (tab === 'users') loadUsers()
  else if (tab === 'groups') loadGroups()
  else if (tab === 'announcement') loadAnnouncements()
  else if (tab === 'dashboard') loadStats()
}

let clockTimer = null
onMounted(() => {
  loadStats()
  clockTimer = setInterval(() => now.value = new Date(), 1000)
})
onBeforeUnmount(() => { if (clockTimer) clearInterval(clockTimer) })
</script>

<template>
  <div class="admin-page">
    <!-- ─── 侧边栏 ─── -->
    <aside class="sidebar">
      <div class="sidebar-header">
        <div class="user-avatar">
          <img v-if="avatarUrl" :src="avatarUrl" alt="" class="avatar-img" />
          <span v-else>{{ nickname.charAt(0) || 'A' }}</span>
        </div>
        <div class="user-detail">
          <span class="user-name">{{ nickname }}</span>
          <span class="badge admin-badge">管理员</span>
        </div>
        <button class="icon-btn" title="退出登录" @click="logout"><Logout size="18" /></button>
      </div>

      <nav class="nav-menu">
        <button :class="{ active: activeTab === 'dashboard' }" @click="switchTab('dashboard')">
          <Dashboard size="16" /> 系统面板
        </button>
        <button :class="{ active: activeTab === 'users' }" @click="switchTab('users')">
          <User size="16" /> 用户管理
        </button>
        <button :class="{ active: activeTab === 'groups' }" @click="switchTab('groups')">
          <Peoples size="16" /> 群组管理
        </button>
        <button :class="{ active: activeTab === 'announcement' }" @click="switchTab('announcement')">
          <Broadcast size="16" /> 全服公告
        </button>
      </nav>

      <div class="sidebar-footer">
        <router-link to="/chat" class="footer-link"><Message size="14" /> 进入聊天室</router-link>
        <router-link to="/" class="footer-link"><Left size="14" /> 返回首页</router-link>
      </div>
    </aside>

    <!-- ─── 主内容区 ─── -->
    <main class="main-area">

      <!-- 系统面板 -->
      <section v-if="activeTab === 'dashboard'" class="panel">
        <div class="panel-header">
          <h2>系统面板</h2>
          <div class="clock">{{ now.toLocaleTimeString('zh-CN') }}</div>
        </div>

        <div class="stats-grid">
          <div class="stat-card">
            <div class="stat-num">{{ stats.totalUsers }}</div>
            <div class="stat-label">总用户数</div>
          </div>
          <div class="stat-card">
            <div class="stat-num">{{ stats.totalMessages }}</div>
            <div class="stat-label">总消息数</div>
          </div>
          <div class="stat-card">
            <div class="stat-num">{{ stats.todayNewUsers }}</div>
            <div class="stat-label">今日新增用户</div>
          </div>
          <div class="stat-card">
            <div class="stat-num">{{ stats.todayNewMessages }}</div>
            <div class="stat-label">今日新增消息</div>
          </div>
        </div>

        <div class="chart-box">
          <h3 class="section-title">近 7 日趋势</h3>
          <div class="chart-wrapper">
            <Line :data="chartData" :options="chartOptions" />
          </div>
        </div>
      </section>

      <!-- 用户管理 -->
      <section v-if="activeTab === 'users'" class="panel">
        <div class="panel-header">
          <h2>用户管理</h2>
          <div class="search-row">
            <input v-model="userSearch" placeholder="搜索昵称或邮箱..." @keyup.enter="loadUsers" />
            <button @click="loadUsers">搜索</button>
          </div>
        </div>

        <div v-if="loadingUsers" class="loading">加载中...</div>

        <table v-else class="data-table">
          <thead>
            <tr>
              <th>昵称</th>
              <th>邮箱</th>
              <th>角色</th>
              <th>注册时间</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="u in users" :key="u.PublicId">
              <td>{{ u.Nickname }}</td>
              <td>{{ u.Email }}</td>
              <td>
                <span v-if="u.IsAdmin" class="badge admin-badge">管理员</span>
                <span v-else class="badge user-badge">用户</span>
              </td>
              <td>{{ formatTime(u.CreateTime) }}</td>
              <td class="actions">
                <button class="btn-sm" @click="handleResetPassword(u.PublicId)">重置密码</button>
                <button v-if="!u.IsAdmin" class="btn-sm btn-danger" @click="handleDeleteUser(u.PublicId)">删除</button>
              </td>
            </tr>
          </tbody>
        </table>
        <p v-if="!loadingUsers && users.length === 0" class="empty">暂无用户</p>
      </section>

      <!-- 群组管理 -->
      <section v-if="activeTab === 'groups'" class="panel">
        <div class="panel-header">
          <h2>群组管理</h2>
        </div>

        <div v-if="loadingGroups" class="loading">加载中...</div>

        <table v-else class="data-table">
          <thead>
            <tr>
              <th>名称</th>
              <th>类型</th>
              <th>成员数</th>
              <th>创建时间</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="g in groups" :key="g.Id">
              <td>{{ g.Name }}</td>
              <td>
                <span v-if="g.IsDefault" class="badge default-badge">默认群</span>
                <span v-else class="badge user-badge">自定义</span>
              </td>
              <td>{{ g.MemberCount }}</td>
              <td>{{ formatTime(g.CreatedAt) }}</td>
              <td class="actions">
                <button v-if="!g.IsDefault" class="btn-sm btn-danger" @click="handleDeleteGroup(g.Id)">删除</button>
                <span v-else class="hint-text">—</span>
              </td>
            </tr>
          </tbody>
        </table>
        <p v-if="!loadingGroups && groups.length === 0" class="empty">暂无群组</p>
      </section>

      <!-- 全服公告 -->
      <section v-if="activeTab === 'announcement'" class="panel">
        <div class="panel-header">
          <h2>全服公告</h2>
        </div>

        <div class="announcement-editor">
          <textarea v-model="announcement" placeholder="输入公告内容..."
            rows="3"></textarea>
          <button class="btn-primary" :disabled="sendingAnnouncement || !announcement.trim()"
            @click="handleSetAnnouncement">
            {{ sendingAnnouncement ? '发布中...' : '发布公告' }}
          </button>
        </div>

        <div class="section-title">公告历史</div>
        <div v-if="announcementHistory.length === 0" class="empty">暂无公告</div>
        <div v-for="a in announcementHistory" :key="a.Id" class="announcement-item">
          <div class="announcement-content">{{ a.Content }}</div>
          <div class="announcement-meta">{{ a.Publisher }} · {{ formatTime(a.CreatedAt) }}</div>
        </div>
      </section>

    </main>
  </div>
</template>

<style scoped>
.admin-page {
  display: flex;
  height: 100vh;
  font-family: "Microsoft YaHei","PingFang SC",Arial,sans-serif;
}

/* ─── 侧边栏 ─── */
.sidebar {
  width: 240px;
  min-width: 240px;
  background: #1e1e2e;
  color: #ccc;
  display: flex;
  flex-direction: column;
}
.sidebar-header {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 16px;
  background: #181825;
}
.user-avatar {
  width: 38px; height: 38px;
  border-radius: 50%;
  background: #f39c12;
  color: white;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 16px;
  font-weight: bold;
  overflow: hidden;
}
.avatar-img { width: 100%; height: 100%; object-fit: cover; }
.user-detail { flex: 1; display: flex; flex-direction: column; min-width: 0; }
.user-name { color: #eee; font-size: 14px; font-weight: 500; }
.icon-btn {
  background: none; border: none; color: #999;
  font-size: 18px; cursor: pointer;
  /* 图标对齐（IconPark SVG）*/
  display: inline-flex; align-items: center; justify-content: center; line-height: 0;
}
.icon-btn:hover { color: #e74c3c; }

.nav-menu {
  flex: 1;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.nav-menu button {
  text-align: left;
  padding: 10px 14px;
  background: none;
  border: none;
  color: #aaa;
  font-size: 14px;
  border-radius: 6px;
  cursor: pointer;
  transition: all 0.15s;
  /* 图标 + 文字横向对齐（IconPark SVG）*/
  display: flex;
  align-items: center;
  gap: 8px;
}
.nav-menu button:hover { background: #2a2a3c; color: #eee; }
.nav-menu button.active { background: #f39c12; color: #fff; }

.sidebar-footer {
  padding: 12px 16px;
  border-top: 1px solid #2a2a3c;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.footer-link {
  color: #888;
  text-decoration: none;
  font-size: 13px;
  /* 图标 + 文字对齐 */
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.footer-link:hover { color: #f39c12; }

/* ─── 主内容区 ─── */
.main-area {
  flex: 1;
  max-width: 1100px;
  background: #f5f6fa;
  overflow-y: auto;
  padding: 24px;
}
.panel-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 16px;
  flex-wrap: wrap;
  gap: 12px;
}
.panel-header h2 { margin: 0; font-size: 20px; color: #333; }

.clock {
  font-size: 14px;
  color: #666;
  font-variant-numeric: tabular-nums;
}

.search-row { display: flex; gap: 8px; }
.search-row input {
  padding: 8px 12px;
  border: 1px solid #ddd;
  border-radius: 6px;
  width: 220px;
  font-size: 13px;
  outline: none;
}
.search-row input:focus { border-color: #f39c12; }
.search-row button {
  padding: 8px 16px;
  background: #f39c12;
  color: white;
  border: none;
  border-radius: 6px;
  cursor: pointer;
  font-size: 13px;
}

/* ─── 表格 ─── */
.data-table {
  width: 100%;
  border-collapse: collapse;
  background: white;
  border-radius: 8px;
  overflow: hidden;
  box-shadow: 0 1px 4px rgba(0,0,0,0.06);
}
.data-table th, .data-table td {
  padding: 12px 16px;
  text-align: left;
  font-size: 13px;
  border-bottom: 1px solid #eee;
  color: #333;
}
.data-table th {
  background: #fafbfc;
  color: #555;
  font-weight: 600;
}
.data-table tr:hover td { background: #fdf6ec; }

.actions { display: flex; gap: 6px; }
.btn-sm {
  padding: 4px 10px;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  font-size: 12px;
  background: #eee;
  color: #555;
}
.btn-sm:hover { background: #ddd; }
.btn-danger { background: #fff0f0; color: #e74c3c; }
.btn-danger:hover { background: #ffe0e0; }
.hint-text { color: #bbb; font-size: 12px; }

/* ─── 标签 ─── */
.badge {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 10px;
  font-size: 11px;
  font-weight: 600;
}
.admin-badge { background: #fdf0d5; color: #b8730a; }
.user-badge { background: #e8f4fd; color: #3a7bd5; }
.default-badge { background: #d5f5e3; color: #1e8449; }

/* ─── 公告 ─── */
.announcement-editor {
  background: white;
  padding: 20px;
  border-radius: 8px;
  box-shadow: 0 1px 4px rgba(0,0,0,0.06);
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.announcement-editor textarea {
  width: 100%;
  padding: 12px;
  border: 1px solid #ddd;
  border-radius: 6px;
  font-size: 14px;
  resize: vertical;
  outline: none;
  font-family: inherit;
  box-sizing: border-box;
}
.announcement-editor textarea:focus { border-color: #f39c12; }
.btn-primary {
  align-self: flex-end;
  padding: 10px 24px;
  background: #f39c12;
  color: white;
  border: none;
  border-radius: 6px;
  cursor: pointer;
  font-size: 14px;
}
.btn-primary:disabled { opacity: 0.5; cursor: default; }

/* ─── 仪表盘 ─── */
.stats-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 16px;
  margin-bottom: 24px;
}
.stat-card {
  background: white;
  border-radius: 10px;
  padding: 20px;
  text-align: center;
  box-shadow: 0 1px 4px rgba(0,0,0,0.06);
}
.stat-num { font-size: 28px; font-weight: 700; color: #333; }
.stat-label { font-size: 13px; color: #999; margin-top: 4px; }

.chart-box {
  background: white;
  border-radius: 10px;
  padding: 20px;
  box-shadow: 0 1px 4px rgba(0,0,0,0.06);
}
.chart-wrapper { height: 280px; }

.section-title {
  font-size: 15px;
  font-weight: 600;
  color: #555;
  margin: 24px 0 12px;
}
.announcement-item {
  background: white;
  border-radius: 8px;
  padding: 14px 16px;
  margin-bottom: 8px;
  box-shadow: 0 1px 3px rgba(0,0,0,0.05);
}
.announcement-content { font-size: 14px; color: #333; line-height: 1.5; }
.announcement-meta { font-size: 12px; color: #999; margin-top: 6px; }

.loading, .empty { text-align: center; color: #999; padding: 40px; font-size: 14px; }
</style>
