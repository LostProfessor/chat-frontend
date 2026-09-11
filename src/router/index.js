/**
 * Vue Router 路由配置文件
 * 
 * 路由表：
 *   /           → HomeView      （首页，入口页）
 *   /login      → LoginView     （登录页）
 *   /register   → RegisterView  （注册页）
 *   /chat       → ChatView      （聊天室，需登录）
 *   /management → ManagementView（管理后台，需登录 + 管理员角色）
 * 
 * 路由守卫：
 *   requiresAuth: 未登录 → /login
 *   requiresAdmin: JWT 中 Role != "Admin" → /chat
 */

import { createRouter, createWebHistory } from 'vue-router'
import HomeView from '../views/HomeView.vue'

function isAdmin() {
  const token = sessionStorage.getItem('token')
  if (!token) return false
  try {
    // JWT 使用 Base64Url，atob 需要标准 Base64
    const base64 = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')
    const payload = JSON.parse(atob(base64))
    const role = payload['http://schemas.microsoft.com/ws/2008/06/identity/claims/role']
    return role === 'Admin'
  } catch {
    return false
  }
}

const routes = [
  {
    path: '/',
    name: 'home',
    component: HomeView
  },
  {
    path: '/login',
    name: 'login',
    component: () => import('../views/LoginView.vue')
  },
  {
    path: '/register',
    name: 'register',
    component: () => import('../views/RegisterView.vue')
  },
  {
    path: '/chat',
    name: 'chat',
    meta: { requiresAuth: true },
    component: () => import('../views/ChatView.vue')
  },
  {
    path: '/management',
    name: 'management',
    meta: { requiresAuth: true, requiresAdmin: true },
    component: () => import('../views/ManagementView.vue')
  }
]

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes
})

router.beforeEach((to, from, next) => {
  if (to.meta.requiresAuth && !sessionStorage.getItem('token')) {
    next('/login')
  } else if (to.meta.requiresAdmin && !isAdmin()) {
    // 非管理员想访问管理后台 → 跳转到聊天室
    next('/chat')
  } else {
    next()
  }
})

export default router
