/**
 * 图标统一出口
 *
 * 全部图标来自 IconPark（字节跳动开源，MIT 许可）
 *   https://github.com/bytedance/IconPark
 *
 * 为什么不直接在各组件里 import '@icon-park/vue-next'：
 *   集中在这一个文件里，以后若要整体换图标库（或改成自研 SVG），
 *   只需改这里，业务组件保持导入的名字不变即可。
 *
 * 用法：
 *   <SettingTwo size="16" />          size 默认 '1em'（跟随 font-size）
 *   <Close />                         颜色默认 currentColor（跟随文字颜色）
 *   <Lightning theme="filled" />      theme: outline(默认) / filled / two-tone / multi-color
 */
export {
  // ── 侧栏 / 导航 ──
  SettingTwo,   // 设置
  Lightning,    // 管理员
  Peoples,      // 群组列表
  Message,      // 私信 / 进入聊天室
  Search,       // 搜索 / 加入群组
  Mail,         // 好友申请
  Left,         // 返回首页
  Logout,       // 退出登录
  Dashboard,    // 系统面板
  User,         // 用户管理
  Broadcast,    // 全服公告
  Announcement, // 群公告
  Close,        // 关闭 / 取消
  Paperclip,    // 发送文件
  VolumeMute,   // 已禁言
  Download,     // 下载

  // ── 密码显隐 ──
  PreviewOpen,
  PreviewClose,

  // ── 文件类型图标 ──
  FilePdf,
  FileZip,
  FileWord,
  FileExcel,
  FilePpt,
  FileTxt,
  FileText,     // 兜底：未知类型

  // ── 音频 ──
  MusicOne
} from '@icon-park/vue-next'
