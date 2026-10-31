const tools=new Map()
await import('file:///E:/deepseekharness/dsh-karing/lib/index.js').then(m=>m.apply({tools:{register:d=>tools.set(d.name,d)}},{mode:'rule'}))
const call=async(n,a)=>{const d=tools.get(n);console.log(`\n──── ${n} ${JSON.stringify(a??{})} ────`);const t=Date.now();try{const o=await d.execute(a??{},{signal:undefined});console.log(String(o).slice(0,1200));console.log(`（${Date.now()-t}ms）`)}catch(e){console.log('❌',e.message)}}
await call('karing_search',{query:'"铁板神数" 皇极经世 考刻',engines:['duckduckgo','bing','wikisource'],limit:3})
await call('karing_fetch',{url:'https://zh.wikisource.org/zh-hans/%E7%85%99%E6%B3%A2%E9%87%A3%E5%8F%9F%E6%AD%8C',maxChars:400})
await call('karing_mode',{mode:'proxy'})
await call('karing_mode',{mode:'rule'})
