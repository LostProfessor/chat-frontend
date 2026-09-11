<script setup>
</script>

<template>
  <div class="home">
    <div class="hero">
      <h1>欢迎来到聊天室</h1>
      <p class="subtitle">实时通信，简单快捷</p>
      <router-link to="/login" class="enter-btn">进入聊天室</router-link>
    </div>
  </div>
</template>

<style scoped>
.home {
  display: flex; justify-content: center; align-items: center;
  min-height: 100vh;
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
}
.hero { text-align: center; color: white; padding: 40px; }
h1 { font-size: 48px; margin-bottom: 16px; }
.subtitle { font-size: 20px; opacity: 0.9; margin-bottom: 40px; }
.enter-btn {
  display: inline-block; padding: 14px 48px; background: white; color: #667eea;
  text-decoration: none; border-radius: 30px; font-size: 18px; font-weight: bold;
  transition: transform 0.2s, box-shadow 0.2s;
}
.enter-btn:hover { transform: translateY(-2px); box-shadow: 0 8px 25px rgba(0, 0, 0, 0.2); }
</style>
