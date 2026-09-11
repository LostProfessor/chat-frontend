<script setup>
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { register as registerApi } from '../api'

const router = useRouter()

const nickname = ref('')
const email = ref('')
const password = ref('')
const confirmPassword = ref('')
const showPwd = ref(false)
const showConfirmPwd = ref(false)
const errorMsg = ref('')
const successMsg = ref('')
const loading = ref(false)

function showPwdHandler() { showPwd.value = true }
function hidePwdHandler() { showPwd.value = false }
function showConfirmHandler() { showConfirmPwd.value = true }
function hideConfirmHandler() { showConfirmPwd.value = false }

async function handleRegister() {
  errorMsg.value = ''
  successMsg.value = ''

  if (!nickname.value || !email.value || !password.value || !confirmPassword.value) {
    errorMsg.value = '请填写所有字段'
    return
  }
  if (password.value !== confirmPassword.value) {
    errorMsg.value = '两次密码输入不一致'
    return
  }
  if (password.value.length < 8) {
    errorMsg.value = '密码长度不能少于8个字符'
    return
  }

  loading.value = true
  try {
    const res = await registerApi(nickname.value, email.value, password.value)
    successMsg.value = res.data.message || '注册成功！即将跳转到登录页...'
    setTimeout(() => router.push('/login'), 2000)
  } catch (err) {
    if (err.response?.data) {
      const msg = typeof err.response.data === 'string' ? err.response.data : err.response.data.message || JSON.stringify(err.response.data)
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
      <h1>注册</h1>
      <p class="subtitle">创建一个新账号</p>

      <form @submit.prevent="handleRegister">
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
            <input v-model="password" :type="showPwd ? 'text' : 'password'" placeholder="至少8位密码" />
            <button type="button" class="pwd-toggle"
              @mousedown="showPwdHandler" @mouseup="hidePwdHandler" @mouseleave="hidePwdHandler">
              {{ showPwd ? '🙈' : '👁' }}
            </button>
          </div>
        </div>
        <div class="form-group">
          <label>确认密码</label>
          <div class="pwd-wrapper">
            <input v-model="confirmPassword" :type="showConfirmPwd ? 'text' : 'password'" placeholder="再次输入密码" />
            <button type="button" class="pwd-toggle"
              @mousedown="showConfirmHandler" @mouseup="hideConfirmHandler" @mouseleave="hideConfirmHandler">
              {{ showConfirmPwd ? '🙈' : '👁' }}
            </button>
          </div>
        </div>

        <p v-if="errorMsg" class="error-msg">{{ errorMsg }}</p>
        <p v-if="successMsg" class="success-msg">{{ successMsg }}</p>

        <button type="submit" class="auth-btn" :disabled="loading">
          {{ loading ? '注册中...' : '注册' }}
        </button>
      </form>

      <p class="switch-link">
        已有账号？
        <router-link to="/login">立即登录</router-link>
      </p>
    </div>
  </div>
</template>

<style scoped>
.auth-page {
  display: flex; justify-content: center; align-items: center;
  min-height: 100vh;
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
}
.auth-card {
  background: white; padding: 40px; border-radius: 16px;
  width: 100%; max-width: 420px;
  box-shadow: 0 10px 40px rgba(0, 0, 0, 0.15);
}
h1 { text-align: center; color: #333; font-size: 28px; margin-bottom: 4px; }
.subtitle { text-align: center; color: #999; margin-bottom: 32px; font-size: 14px; }
.form-group { margin-bottom: 20px; }
.form-group label { display: block; margin-bottom: 6px; color: #555; font-size: 14px; font-weight: 500; }
.form-group input {
  width: 100%; padding: 12px 14px; border: 1px solid #ddd; border-radius: 8px;
  font-size: 14px; outline: none; transition: border-color 0.2s; box-sizing: border-box;
}
.form-group input:focus { border-color: #667eea; }
.pwd-wrapper {
  display: flex; align-items: center; border: 1px solid #ddd; border-radius: 8px; transition: border-color 0.2s;
}
.pwd-wrapper:focus-within { border-color: #667eea; }
.pwd-wrapper input { border: none !important; flex: 1; }
.pwd-toggle { background: none; border: none; cursor: pointer; padding: 0 12px; font-size: 16px; line-height: 1; user-select: none; }
.error-msg { color: #e74c3c; font-size: 13px; text-align: center; margin-bottom: 12px; }
.success-msg { color: #27ae60; font-size: 13px; text-align: center; margin-bottom: 12px; }
.auth-btn {
  width: 100%; padding: 12px;
  background: linear-gradient(135deg, #667eea, #764ba2);
  color: white; border: none; border-radius: 8px;
  font-size: 16px; font-weight: 600; cursor: pointer; transition: opacity 0.2s;
}
.auth-btn:hover { opacity: 0.9; }
.auth-btn:disabled { opacity: 0.6; cursor: not-allowed; }
.switch-link { text-align: center; margin-top: 20px; color: #999; font-size: 14px; }
.switch-link a { color: #667eea; text-decoration: none; font-weight: 500; }
.switch-link a:hover { text-decoration: underline; }
</style>
