/**
 * @local/dsh-sidebar-tidy —— 浏览器侧：注入一小段 CSS，给侧边栏「让位」。
 *
 * 格式遵循 DSH 客户端插件契约（window.__ModuleLoader__.load + factory(require) → {inject, apply}）。
 *
 * 解决什么（2026-10-06）：
 *   DSH 侧边栏竖向布局是
 *     logoRow(品牌, flex:none, 60px) → newSession(flex:none) → panelList(flex:none)
 *     → regionArea(项目/会话列表, flex:1) → footArea(插件动作区, flex:none)
 *   已装插件里只有 dsh-cost-meter 与 @agents-anywhere/dsh-bridge-next 注册侧边栏，
 *   且都落在 footArea。footArea 是 flex:none —— 内容多高就占多高、绝不收缩；
 *   一旦它长起来（例如「手机连接」在侧边栏内联渲染 256×256 二维码），
 *   regionArea 就被压扁，项目列表只剩几行、点不到。
 *
 * 只做布局层四件事，不改任何插件行为，删除本包即回滚：
 *   1. footArea 限高 + 内部滚动；
 *   2. 侧边栏内联二维码缩到 132px；
 *   3. 品牌行 60→44px、新会话按钮下边距 12→8px；
 *   4. 费用条 .cm-foot 压到 26px、余额盒限高可滚。
 *
 * 选择器说明：DSH 自身类名是 CSS-module 哈希（_2H3hWW_footArea），但**后缀稳定**，
 * 故用 [class*="_footArea"]；插件自有类名（KV--Pq_*、.cm-*）稳定，直接点名。
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-sidebar-tidy',
  factory(require) {
    const CSS = [
      '/* 1) 插件动作区（费用 / 手机连接 / 设置）限高 + 内部滚动 */',
      '[class*="_footArea"] { max-height: 34vh !important; overflow-y: auto !important; overscroll-behavior: contain; }',
      '',
      '/* 2) 侧边栏内联二维码缩小 */',
      'img[alt*="二维码"], img[alt*="QR"] { width: min(132px, 100%) !important; height: auto !important; }',
      '[class*="KV--Pq_qr"] { width: min(132px, 100%) !important; height: auto !important; }',
      '[class*="KV--Pq_content"] { padding: 10px 0 !important; gap: 8px !important; }',
      '',
      '/* 3) 顶部收紧 */',
      '[class*="_logoRow"] { height: 44px !important; margin-bottom: 0 !important; }',
      '[class*="_newSession"] { margin-bottom: 8px !important; }',
      '',
      '/* 4) 费用条紧凑、余额盒限高可滚 */',
      '.cm-foot { height: 26px !important; }',
      '.cm-bbox { max-height: 128px; overflow-y: auto; }',
      '',
    ].join('\n')

    function injectStyles() {
      if (typeof document === 'undefined') return
      if (document.querySelector('style[data-dsh-sidebar-tidy]') !== null) return
      const style = document.createElement('style')
      style.setAttribute('data-dsh-sidebar-tidy', '1')
      style.textContent = CSS
      document.head.appendChild(style)
    }

    return {
      inject: [],
      apply() {
        injectStyles()
      },
    }
  },
})
