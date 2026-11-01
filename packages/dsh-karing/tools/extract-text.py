#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
extract-text — 把 mingli-corpus 里不可检索的二进制资料（PDF / DOC / DOCX / XLS / XLSX）
抽成 .md，写进 `_转换文本/`，让 dsh-corpus 的 bigram 索引能搜到。

为什么需要：dsh-corpus 只索引 .md / .jsonl。语料库里 197 个 PDF、42 个 .doc、29 个 .docx、
7 个表格本身完全搜不到 —— 等于"收进来了但用不了"。

设计要点：
  * 默认 dry-run，只打印统计；加 --apply 才写盘。
  * 扫描件（无文字层）抽不出字 → 不写空文件，单独列进报告，供后续 OCR 决策。
  * 输出镜像原目录结构，落在 `mingli-corpus/_转换文本/<原相对目录>/<原名>.md`，
    带 front-matter 记录来源、页数、字数、抽取器 —— 整目录删掉即可完全回滚。
  * 幂等：目标已存在且源文件 mtime/size 没变则跳过。

用法：
    python tools/extract-text.py                 # 干跑，只看统计
    python tools/extract-text.py --apply         # 写盘
    python tools/extract-text.py --apply --only pdf
"""
import os
import sys
import json
import time

CORPUS = r'E:\deepseekharness\mingli-corpus'
OUTDIR = '_转换文本'
REPORT = '_转换报告.json'

APPLY = '--apply' in sys.argv
ONLY = None
if '--only' in sys.argv:
    i = sys.argv.index('--only')
    if i + 1 < len(sys.argv):
        ONLY = sys.argv[i + 1].lower()

MIN_CHARS = 200  # 低于此值视为"抽不出文字"，不写盘


def walk_corpus():
    for dirpath, dirnames, filenames in os.walk(CORPUS):
        dirnames[:] = [d for d in dirnames if d != OUTDIR]
        for name in filenames:
            ext = name.rsplit('.', 1)[-1].lower() if '.' in name else ''
            if ONLY and ext != ONLY:
                continue
            if ext not in ('pdf', 'doc', 'docx', 'xls', 'xlsx', 'rar'):
                continue
            yield os.path.join(dirpath, name), ext


def from_pdf(path):
    import fitz
    doc = fitz.open(path)
    pages = doc.page_count
    parts = []
    for i, page in enumerate(doc):
        t = page.get_text()
        if t and t.strip():
            parts.append(t)
    doc.close()
    return '\n\n'.join(parts), pages, 'PyMuPDF'


def from_docx(path):
    try:
        import docx
        d = docx.Document(path)
        parts = [p.text for p in d.paragraphs if p.text and p.text.strip()]
        for tbl in d.tables:
            for row in tbl.rows:
                cells = [c.text.strip() for c in row.cells if c.text and c.text.strip()]
                if cells:
                    parts.append(' | '.join(cells))
        return '\n'.join(parts), None, 'python-docx'
    except Exception:
        # 有的 docx 内嵌图片 CRC 坏了，python-docx 整包加载会失败。
        # 退路：只读 word/document.xml，按段落切 <w:t> 文本，绕开 media。
        import zipfile
        import re
        with zipfile.ZipFile(path) as zf:
            xml = zf.read('word/document.xml').decode('utf-8', 'replace')
        paras = re.split(r'</w:p>', xml)
        parts = []
        for p in paras:
            runs = re.findall(r'<w:t[^>]*>(.*?)</w:t>', p, re.S)
            line = ''.join(runs)
            line = (line.replace('&amp;', '&').replace('&lt;', '<')
                        .replace('&gt;', '>').replace('&quot;', '"'))
            if line.strip():
                parts.append(line)
        return '\n'.join(parts), None, 'docx-xml-fallback'


def from_doc(path):
    import subprocess
    r = subprocess.run(['antiword', '-m', 'UTF-8.txt', path],
                       capture_output=True, timeout=120)
    txt = r.stdout.decode('utf-8', 'replace')
    if not txt.strip():
        r = subprocess.run(['antiword', path], capture_output=True, timeout=120)
        txt = r.stdout.decode('utf-8', 'replace')
    return txt, None, 'antiword'


def from_excel(path):
    ext = path.rsplit('.', 1)[-1].lower()
    parts = []
    if ext == 'xlsx':
        import openpyxl
        wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
        for ws in wb.worksheets:
            parts.append(f'## 表：{ws.title}')
            for row in ws.iter_rows(values_only=True):
                cells = [str(c) for c in row if c not in (None, '')]
                if cells:
                    parts.append(' | '.join(cells))
        wb.close()
    else:
        import xlrd
        wb = xlrd.open_workbook(path)
        for ws in wb.sheets():
            parts.append(f'## 表：{ws.name}')
            for r in range(ws.nrows):
                cells = [str(c.value) for c in ws.row(r) if str(c.value).strip()]
                if cells:
                    parts.append(' | '.join(cells))
    return '\n'.join(parts), None, 'openpyxl/xlrd'


EXTRACTORS = {'pdf': from_pdf, 'docx': from_docx, 'doc': from_doc,
              'xlsx': from_excel, 'xls': from_excel}


def main():
    files = list(walk_corpus())
    files.sort()
    stats = {'ok': [], 'scanned': [], 'error': [], 'skipped': [], 'no_tool': [], 'dup': []}
    seen_hash = {}
    import hashlib
    import re as _re
    t0 = time.time()
    total_chars = 0

    for path, ext in files:
        rel = os.path.relpath(path, CORPUS)
        base = os.path.splitext(rel)[0]
        dst = os.path.join(CORPUS, OUTDIR, base + '.md')

        if ext == 'rar':
            stats['no_tool'].append(rel)
            continue

        if os.path.exists(dst):
            try:
                if os.path.getmtime(dst) >= os.path.getmtime(path):
                    stats['skipped'].append(rel)
                    continue
            except OSError:
                pass

        fn = EXTRACTORS.get(ext)
        if fn is None:
            stats['no_tool'].append(rel)
            continue

        try:
            text, pages, tool = fn(path)
        except Exception as e:
            stats['error'].append(f'{rel}\t{type(e).__name__}: {e}')
            continue

        text = (text or '').strip()
        chars = len(text)
        if chars < MIN_CHARS:
            stats['scanned'].append(f'{rel}\t{chars}字')
            continue

        # 内容级去重：同一本书存了多份时，只转第一份
        norm = _re.sub(r'\s+', '', text)
        h = hashlib.sha1(norm.encode('utf-8', 'replace')).hexdigest()
        if h in seen_hash:
            stats['dup'].append(f'{rel}\t同 {seen_hash[h]}')
            continue
        seen_hash[h] = rel

        stem = os.path.splitext(os.path.basename(rel))[0]
        fm = [
            '---',
            f'source: {rel.replace(os.sep, "/")}',
            f'extractor: {tool}',
            f'pages: {pages if pages is not None else "-"}',
            f'chars: {chars}',
            '---',
            '',
            f'# {stem}',
            '',
        ]
        body = '\n'.join(fm) + text + '\n'
        stats['ok'].append((rel, chars))
        total_chars += chars

        if APPLY:
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            with open(dst, 'w', encoding='utf-8', newline='\n') as fh:
                fh.write(body)

    dur = time.time() - t0
    out = []
    out.append(f'{"【写盘】" if APPLY else "【干跑】"} {len(files)} 个候选文件，用时 {dur:.1f}s')
    out.append(f'  可抽取      {len(stats["ok"]):4d} 个，累计 {total_chars:,} 字')
    out.append(f'  扫描件无字层 {len(stats["scanned"]):4d} 个（不写空文件，待 OCR 决策）')
    out.append(f'  内容重复    {len(stats["dup"]):4d} 个（同一本书的多份副本，只转一份）')
    out.append(f'  已是最新    {len(stats["skipped"]):4d} 个')
    out.append(f'  无可用工具  {len(stats["no_tool"]):4d} 个（rar 解压器缺失）')
    out.append(f'  出错        {len(stats["error"]):4d} 个')
    if stats['ok']:
        out.append('\n  产出最大的 10 个：')
        for rel, c in sorted(stats['ok'], key=lambda x: -x[1])[:10]:
            out.append(f'    {c:8,d}字  {rel}')
    if stats['scanned']:
        out.append('\n  扫描件（前 10）：')
        for s in stats['scanned'][:10]:
            out.append(f'    {s}')
    if stats['dup']:
        out.append('\n  重复副本（前 10）：')
        for s2 in stats['dup'][:10]:
            out.append(f'    {s2}')
    if stats['error']:
        out.append('\n  出错（前 10）：')
        for s in stats['error'][:10]:
            out.append(f'    {s}')
    if stats['no_tool']:
        out.append('\n  无工具（需 7-Zip/unrar）：')
        for s in stats['no_tool'][:10]:
            out.append(f'    {s}')

    text_report = '\n'.join(out)

    if APPLY:
        payload = {
            'generatedAt': time.strftime('%Y-%m-%dT%H:%M:%S'),
            'ok': [{'src': r, 'chars': c} for r, c in stats['ok']],
            'scanned': stats['scanned'],
            'dup': stats['dup'],
            'error': stats['error'],
            'noTool': stats['no_tool'],
        }
        with open(os.path.join(CORPUS, REPORT), 'w', encoding='utf-8') as fh:
            json.dump(payload, fh, ensure_ascii=False, indent=1)

    sys.stdout.buffer.write((text_report + '\n').encode('utf-8'))


if __name__ == '__main__':
    main()
