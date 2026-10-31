/** dsh-corpus 命令行（与 DSH 三个工具共用同一份 lib）。 */
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildIndex, saveIndex, loadIndex } from '../lib/store.js'
import { search, readDoc } from '../lib/search.js'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const CORPUS = 'E:/deepseekharness/mingli-corpus'
const DATA = join(ROOT, 'data')
const argv = process.argv.slice(2)
const cmd = argv[0] ?? 'help'
const argOf = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[i + 1] : d }

const human = (n) => (n >= 10000 ? `${(n / 10000).toFixed(1)} 万字` : `${n} 字`)

if (cmd === 'index') {
  const built = buildIndex({ root: CORPUS })
  const saved = saveIndex(DATA, { ...built, root: CORPUS })
  console.log(`✅ 索引 ${built.docs.length} 篇 / ${human(built.chars)} / bigram ${built.postings.size} / ${built.ms}ms / ${(saved.bytes / 1048576).toFixed(1)} MB`)
  console.log(`   ${saved.file}`)
} else if (cmd === 'status') {
  const idx = loadIndex(DATA)
  if (idx === undefined) { console.log('还没有索引，先跑 node tools/corpus-cli.mjs index'); process.exit(0) }
  const kinds = {}
  for (const d of idx.docs) kinds[d.kind] = (kinds[d.kind] ?? 0) + 1
  console.log(`文档 ${idx.docs.length} 篇 / ${human(idx.chars)} / bigram ${Object.keys(idx.postings).length}`)
  console.log(`索引 ${(idx.bytes / 1048576).toFixed(1)} MB，构建于 ${idx.builtAt}`)
  console.log(`类型：${Object.entries(kinds).map(([k, v]) => `${k} ${v}`).join(' ｜ ')}`)
} else if (cmd === 'search') {
  const q = argOf('q', argv[1] && !argv[1].startsWith('--') ? argv[1] : '')
  const idx = loadIndex(DATA)
  if (idx === undefined) { console.log('还没有索引'); process.exit(1) }
  const r = search(idx, q, { limit: Number(argOf('limit', '10')), contextChars: Number(argOf('context', '80')) })
  console.log(`"${q}" → ${r.total} 篇命中（${r.ms}ms）`)
  for (const [i, h] of r.hits.entries()) {
    console.log(`\n${i + 1}. [${h.kind}] ${h.name.slice(0, 56)} — ${h.count} 次`)
    console.log(`   ${h.rel}`)
    console.log(`   ${h.snippet}`)
  }
} else if (cmd === 'read') {
  const idx = loadIndex(DATA)
  const r = readDoc(idx, { name: argOf('name', ''), rel: argOf('rel', ''), chars: Number(argOf('chars', '1200')) })
  if (r === undefined) { console.log('没找到'); process.exit(1) }
  console.log(`【${r.doc.rel}】${r.doc.chars} 字\n`)
  console.log(r.text)
} else {
  console.log(`dsh-corpus CLI
  node tools/corpus-cli.mjs index                    重建索引
  node tools/corpus-cli.mjs status                   索引状态
  node tools/corpus-cli.mjs search "紫微 用神" --limit 10
  node tools/corpus-cli.mjs read --name 張果星宗 --chars 2000`)
}
