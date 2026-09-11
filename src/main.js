import './assets/main.css'
// IconPark 图标基础样式（提供 .i-icon 的 color:inherit 与基线对齐）
import '@icon-park/vue-next/styles/index.css'

import { createApp } from 'vue'
import App from './App.vue'
import router from './router'

const app = createApp(App)

app.use(router)
app.mount('#app')
