<script setup>
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { login as loginApi } from '../api'

const router = useRouter()

const nickname = ref('')
const email = ref('')
const password = ref('')
const showPwd = ref(false)
const errorMsg = ref('')
const loading = ref(false)

function showPwdHandler() { showPwd.value = true }
function hidePwdHandler() { showPwd.value = false }

async function handleLogin() {
  errorMsg.value = ''
  if (!nickname.value || !email.value || !password.value) {
    errorMsg.value = '请填写所有字段'
    return
  }

  loading.value = true
  try {
    const res = await loginApi(nickname.value, email.value, password.value)
    const data = res.data

    if (data.token) {
      sessionStorage.setItem('token', data.token)
      sessionStorage.setItem('refreshToken', data.refreshToken || '')
      sessionStorage.setItem('publicId', data.publicId)
      sessionStorage.setItem('isAdmin', data.isAdmin || false)
      sessionStorage.setItem('nickname', nickname.value)
      router.push('/chat')
    } else {
      errorMsg.value = data.message || '登录成功，但未获取到 token'
    }
  } catch (err) {
    if (err.response?.data) {
      const msg = typeof err.response.data === 'string'
        ? err.response.data
        : err.response.data.message || JSON.stringify(err.response.data)
      errorMsg.value = msg
    } else {
      errorMsg.value = '网络错误，请检查后端是否启动'
    }
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <div class="auth-page">
    <div class="auth-card">
      <h1>登录</h1>
      <p class="subtitle">欢迎回到聊天室</p>

      <form @submit.prevent="handleLogin">
        <div class="form-group">
          <label>昵称</label>
          <input v-model="nickname" type="text" placeholder="请输入昵称" />
        </div>
        <div class="form-group">
          <label>邮箱</label>
          <input v-model="email" type="email" placeholder="请输入邮箱" />
        </div>
        <div class="form-group">
          <label>密码</label>
          <div class="pwd-wrapper">
            <input v-model="password" :type="showPwd ? 'text' : 'password'" placeholder="请输入密码" />
            <button type="button" class="pwd-toggle"
              @mousedown="showPwdHandler" @mouseup="hidePwdHandler" @mouseleave="hidePwdHandler">
              {{ showPwd ? '🙈' : '👁' }}
            </button>
          </div>
        </div>

        <p v-if="errorMsg" class="error-msg">{{ errorMsg }}</p>

        <button type="submit" class="auth-btn" :disabled="loading">
          {{ loading ? '登录中...' : '登录' }}
        </button>
      </form>

      <p class="switch-link">
        还没有账号？
        <router-link to="/register">立即注册</router-link>
      </p>
    </div>
  </div>
</template>

<style scoped>
.auth-page {
  display: flex;
  justify-content: center;
  align-items: center;
  min-height: 100vh;
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
}

.auth-card {
  background: white;
  padding: 40px;
  border-radius: 16px;
  width: 100%;
  max-width: 420px;
  box-shadow: 0 10px 40px rgba(0, 0, 0, 0.15);
}

h1 {
  text-align: center;
  color: #333;
  font-size: 28px;
  margin-bottom: 4px;
}

.subtitle {
  text-align: center;
  color: #999;
  margin-bottom: 32px;
  font-size: 14px;
}

.form-group {
  margin-bottom: 20px;
}

.form-group label {
  display: block;
  margin-bottom: 6px;
  color: #555;
  font-size: 14px;
  font-weight: 500;
}

.form-group input {
  width: 100%;
  padding: 12px 14px;
  border: 1px solid #ddd;
  border-radius: 8px;
  font-size: 14px;
  outline: none;
  transition: border-color 0.2s;
  box-sizing: border-box;
}

.form-group input:focus {
  border-color: #667eea;
}

.pwd-wrapper {
  display: flex;
  align-items: center;
  border: 1px solid #ddd;
  border-radius: 8px;
  transition: border-color 0.2s;
}

.pwd-wrapper:focus-within {
  border-color: #667eea;
}

.pwd-wrapper input {
  border: none !important;
  flex: 1;
}

.pwd-toggle {
  background: none;
  border: none;
  cursor: pointer;
  padding: 0 12px;
  font-size: 16px;
  line-height: 1;
  user-select: none;
}

.error-msg {
  color: #e74c3c;
  font-size: 13px;
  text-align: center;
  margin-bottom: 12px;
}

.auth-btn {
  width: 100%;
  padding: 12px;
  background: linear-gradient(135deg, #667eea, #764ba2);
  color: white;
  border: none;
  border-radius: 8px;
  font-size: 16px;
  font-weight: 600;
  cursor: pointer;
  transition: opacity 0.2s;
}

.auth-btn:hover { opacity: 0.9; }
.auth-btn:disabled { opacity: 0.6; cursor: not-allowed; }

.switch-link {
  text-align: center;
  margin-top: 20px;
  color: #999;
  font-size: 14px;
}

.switch-link a {
  color: #667eea;
  text-decoration: none;
  font-weight: 500;
}

.switch-link a:hover { text-decoration: underline; }
</style>
