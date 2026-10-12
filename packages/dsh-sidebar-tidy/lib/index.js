/**
 * @local/dsh-sidebar-tidy —— 宿主侧占位插件。
 * 本包的作用全在浏览器侧（lib/client.js 注入 CSS），宿主不注册任何服务与工具。
 */

/** Cordis 插件名（供加载器诊断使用）。 */
export const name = 'sidebar-tidy'

/** 无服务依赖：不 inject 任何东西。 */
export const inject = []

/** 什么都不做——保持零副作用。 */
export function apply() {}
