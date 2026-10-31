/**
 * 维基文库 wikitext 后处理 —— 把已归档的 `古籍-*.md` 里残留的 wiki 标记（表格/标题/链接）
 * 清洗成可读文本。**不需要重新联网**，只改本地文件。
 *
 * 用法：node tools/clean-wikitext.mjs [--root <语料根>] [--dry]
 */
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, relative } from 'node:path'

const args = process.argv.slice(2)
const i = args.indexOf('--root')
const ROOT = i >= 0 && args[i + 1] !== undefined ? args[i + 1] : 'E:\\deepseekharness\\mingli-corpus'
const DRY = args.includes('--dry')

/** wikitext → 可读文本（表格转成「单元格 | 单元格」的行） */
export function cleanWikitext(t) {
  let s = String(t ?? '')
  s = s.replace(/<noinclude>[\s\S]*?<\/noinclude>/g, '')
  s = s.replace(/<ref[\s\S]*?<\/ref>/g, '')
  s = s.replace(/<[^>]+>/g, '')
  s = s.replace(/\{\{[\s\S]{0,400}?\}\}/g, '')
  // 标题：== X == → ## X
  s = s.replace(/^\s*={2,6}\s*(.+?)\s*={2,6}\s*$/gm, (_m, x) => `## ${x.trim()}`)
  // 表格
  s = s.split('\n').map((line) => {
    const l = line.trim()
    if (/^\{\|/.test(l)) return ''
    if (/^\|\}/.test(l)) return ''
    if (/^\|-/.test(l)) return '\n'
    if (/^\|\+/.test(l)) return `**${l.replace(/^\|\+\s*/, '')}**`
    if (/^!/.test(l)) return `**${l.replace(/^!\s*/, '').replace(/\s*!!\s*/g, ' | ')}**`
    if (/^\|/.test(l)) return `${l.replace(/^\|\s*/, '').replace(/\s*\|\|\s*/g, ' | ').replace(/\s*\|\s*/g, ' | ')} |`
    return line
  }).join('\n')
  s = s.replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
  s = s.replace(/\[\[([^\]]+)\]\]/g, '$1')
  s = s.replace(/'''?/g, '')
  s = s.replace(/\n{3,}/g, '\n\n')
  return s.trim()
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    const st = statSync(full)
    if (st.isDirectory()) walk(full, out)
    else out.push(full)
  }
  return out
}

if (!existsSync(ROOT)) { console.log(`根目录不存在：${ROOT}`); process.exit(1) }
const files = walk(ROOT).filter((f) => f.endsWith('.md') && /古籍-/.test(f))
let changed = 0
let savedChars = 0
for (const f of files) {
  const raw = readFileSync(f, 'utf8')
  if (!raw.includes('维基文库 MediaWiki API')) continue
  const parts = raw.split(/^(?=# )/m)
  const head = parts[0]
  const bodyRaw = parts.slice(1).join('')
  const body = cleanWikitext(bodyRaw)
  if (body.length === bodyRaw.length && !/[|{]=|^\s*\|/m.test(bodyRaw)) continue
  const out = `${head}${body}\n`
  if (!DRY) writeFileSync(f, out, 'utf8')
  changed += 1
  savedChars += Math.max(0, bodyRaw.length - body.length)
  console.log(`${DRY ? '[dry] ' : ''}${relative(ROOT, f)}  ${bodyRaw.length} → ${body.length} 字`)
}
console.log(`\n处理 ${files.length} 个古籍文件，清洗 ${changed} 个，去掉标记 ${savedChars} 字符${DRY ? '（dry-run，未写盘）' : ''}`)
