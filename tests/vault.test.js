/**
 * vault.js 回归测试：「一条记忆 = 一个 md 文件」的文件层。
 */
import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  deleteVaultEntry,
  isValidEntryId,
  newEntryId,
  nextSeq,
  parseEntryFile,
  readVault,
  renderEntryFile,
  slugifyTitle,
  sortEntries,
  syncVault,
  uniqueFilePath,
  vaultCount,
  vaultExists,
  writeVaultEntry,
} from '../lib/vault.js'
import { tmproot } from './_tmp.js'

let root
before(() => {
  root = tmproot("vault-test-")
})
after(() => {
  rmSync(root, { recursive: true, force: true })
})

const baseEntry = (over = {}) => ({
  id: newEntryId(),
  title: '标题',
  summary: '摘要',
  keywords: [],
  scenario: '',
  created: '2026-10-15 02:54',
  updated: '2026-10-15 02:54',
  group: 'kb',
  klass: 'global',
  seq: 1,
  git: '',
  project: '',
  branches: [],
  dshOnly: false,
  archivedAt: null,
  body: '正文内容',
  ...over,
})

describe('vault: 文件名清洗', () => {
  it('非法字符换成下划线', () => {
    assert.equal(slugifyTitle('a/b\\c:d*e?f"g<h>i|j'), 'a_b_c_d_e_f_g_h_i_j')
  })
  it('折叠空白并去掉首尾点与空格', () => {
    assert.equal(slugifyTitle('  ..标题   带空格..  '), '标题 带空格')
  })
  it('超长截断到 60 字', () => {
    assert.equal(slugifyTitle('啊'.repeat(120)).length, 60)
  })
  it('空标题用兜底名', () => {
    assert.equal(slugifyTitle('   ', 'entry-ab12cd'), 'entry-ab12cd')
    assert.equal(slugifyTitle('...', 'entry-ab12cd'), 'entry-ab12cd')
  })
  it('控制字符被清掉', () => {
    assert.equal(slugifyTitle('a\u0001b'), 'a_b')
  })
})

describe('vault: frontmatter 往返', () => {
  it('全字段往返一致', () => {
    const entry = baseEntry({
      title: '群组: 含冒号 # 与引号"的标题',
      summary: '摘要里有\n换行',
      keywords: ['高成熟度', '编码'],
      scenario: '需要重建索引时',
      git: 'main',
      project: 'Proj',
      branches: ['main', 'dev'],
      dshOnly: true,
      archivedAt: '2026-10-15 03:00',
      body: '第一行\n第二行 [summary:假标签]',
    })
    const { meta, body } = parseEntryFile(renderEntryFile(entry))
    assert.equal(meta.id, entry.id)
    assert.equal(meta.title, entry.title)
    assert.equal(meta.summary, entry.summary)
    assert.deepEqual(meta.keywords, ['高成熟度', '编码'])
    assert.equal(meta.scenario, entry.scenario)
    assert.equal(meta.git, 'main')
    assert.equal(meta.project, 'Proj')
    assert.deepEqual(meta.branches, ['main', 'dev'])
    assert.equal(meta.flags, '[dsh-only]')
    assert.equal(meta.archivedAt, '2026-10-15 03:00')
    assert.equal(meta.class, 'global')
    // 正文原样保留（含看起来像标签的文本）
    assert.equal(body, '第一行\n第二行 [summary:假标签]')
  })
  it('没有 frontmatter 的文件被识别为非新格式', () => {
    const { meta, body } = parseEntryFile('旧的纯文本条目\n§\n第二条')
    assert.deepEqual(meta, {})
    assert.equal(body, '旧的纯文本条目\n§\n第二条')
  })
  it('空字段不写进 frontmatter', () => {
    const entry = baseEntry({ keywords: [], scenario: '', summary: '', archivedAt: null })
    const text = renderEntryFile(entry)
    assert.ok(!text.includes('keywords:'))
    assert.ok(!text.includes('scenario:'))
    assert.ok(!text.includes('summary:'))
    assert.ok(!text.includes('archivedAt:'))
  })
})

describe('vault: 读写与去重', () => {
  it('写入后能读回，文件名为标题', () => {
    const dir = join(root, 'kb')
    const entry = baseEntry({ title: 'DSH 删除会话要清的东西' })
    const file = writeVaultEntry(dir, entry)
    assert.equal(file, join(dir, 'DSH 删除会话要清的东西.md'))
    const back = readVault(dir)
    assert.equal(back.length, 1)
    assert.equal(back[0].title, 'DSH 删除会话要清的东西')
    assert.equal(back[0].id, entry.id)
    assert.equal(back[0].body, '正文内容')
  })
  it('同名标题自动加 -2 后缀', () => {
    const dir = join(root, 'dup')
    writeVaultEntry(dir, baseEntry({ title: '同名' }))
    writeVaultEntry(dir, baseEntry({ title: '同名' }))
    const files = readdirSync(dir).sort()
    assert.deepEqual(files, ['同名-2.md', '同名.md'])
  })
  it('改标题即改文件名，旧文件被清理，id 不变', () => {
    const dir = join(root, 'rename')
    const entry = baseEntry({ title: '旧标题' })
    const oldFile = writeVaultEntry(dir, entry)
    const listed = readVault(dir)[0]
    const idBefore = listed.id
    listed.title = '新标题'
    const newFile = writeVaultEntry(dir, listed)
    assert.notEqual(newFile, oldFile)
    assert.equal(readdirSync(dir).length, 1)
    const after = readVault(dir)[0]
    assert.equal(after.title, '新标题')
    assert.equal(after.id, idBefore)
  })
  it('uniqueFilePath 会避开已占用名', () => {
    const dir = join(root, 'unique')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'x.md'), 'x')
    assert.equal(uniqueFilePath(dir, 'x'), join(dir, 'x-2.md'))
  })
  it('已存在的文件不让位给自己（更新场景）', () => {
    const dir = join(root, 'self')
    mkdirSync(dir, { recursive: true })
    const f = join(dir, 'x.md')
    writeFileSync(f, 'x')
    assert.equal(uniqueFilePath(dir, 'x', f), f)
  })
})

describe('vault: 全量同步（replace/remove 的基础）', () => {
  it('增改删一次到位', () => {
    const dir = join(root, 'sync')
    const a = baseEntry({ title: 'A' })
    const b = baseEntry({ title: 'B' })
    syncVault(dir, [a, b])
    assert.equal(vaultCount(dir), 2)
    const entries = readVault(dir)
    // 改 B 的正文、删 A、加 C
    const bEntry = entries.find((e) => e.title === 'B')
    bEntry.body = 'B 改过了'
    const c = baseEntry({ title: 'C' })
    const result = syncVault(dir, [bEntry, c])
    assert.equal(result.removed, 1)
    assert.equal(result.added, 1)
    const after = readVault(dir).map((e) => e.title).sort()
    assert.deepEqual(after, ['B', 'C'])
    assert.equal(readVault(dir).find((e) => e.title === 'B').body, 'B 改过了')
  })
  it('syncVault 不吃掉非 md 文件', () => {
    const dir = join(root, 'keep-other')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'notes.txt'), 'x')
    syncVault(dir, [baseEntry({ title: 'A' })])
    assert.ok(readdirSync(dir).includes('notes.txt'))
  })
  it('deleteVaultEntry 幂等', () => {
    const dir = join(root, 'del')
    const entry = baseEntry({ title: 'D' })
    writeVaultEntry(dir, entry)
    const listed = readVault(dir)[0]
    assert.equal(deleteVaultEntry(listed), true)
    assert.equal(deleteVaultEntry(listed), false)
    assert.equal(vaultCount(dir), 0)
    assert.equal(vaultExists(dir), false)
  })
})

describe('vault: 排序与序号', () => {
  it('按 created 升序、seq 保序', () => {
    const mk = (created, seq, title) => baseEntry({ created, seq, title })
    const sorted = sortEntries([
      mk('2026-10-15 10:00', 2, 'c'),
      mk('2026-10-14 09:00', 9, 'a'),
      mk('2026-10-15 10:00', 1, 'b'),
    ])
    assert.deepEqual(sorted.map((e) => e.title), ['a', 'b', 'c'])
  })
  it('nextSeq 取最大值加一', () => {
    assert.equal(nextSeq([{ seq: 3 }, { seq: 7 }, { seq: 5 }]), 8)
    assert.equal(nextSeq([]), 1)
  })
  it('ID 校验', () => {
    assert.equal(isValidEntryId('a1b2c3d4'), true)
    assert.equal(isValidEntryId('A1B2C3D4'), false)
    assert.equal(isValidEntryId('zz'), false)
    assert.equal(newEntryId().length, 8)
  })
})

describe('vault: 健壮性', () => {
  it('目录不存在时读出空数组', () => {
    assert.deepEqual(readVault(join(root, 'nope')), [])
  })
  it('单个坏文件不拖垮整个分组', () => {
    const dir = join(root, 'broken')
    mkdirSync(dir, { recursive: true })
    writeVaultEntry(dir, baseEntry({ title: '好条目' }))
    writeFileSync(join(dir, '坏条目.md'), '这不是新格式，没有 frontmatter')
    const entries = readVault(dir)
    assert.equal(entries.length, 2)
    const bad = entries.find((e) => e.file.endsWith('坏条目.md'))
    assert.ok(bad, '无 frontmatter 的文件也应被读成条目（迁移兜底）')
    assert.equal(bad.body, '这不是新格式，没有 frontmatter')
  })
  it('子目录不被当成条目', () => {
    const dir = join(root, 'withsub')
    mkdirSync(join(dir, 'archive'), { recursive: true })
    writeVaultEntry(dir, baseEntry({ title: 'A' }))
    assert.equal(vaultCount(dir), 1)
  })
  it('写入是原子替换（读到的是完整内容）', () => {
    const dir = join(root, 'atomic')
    const entry = baseEntry({ title: 'A', body: 'x'.repeat(5000) })
    const file = writeVaultEntry(dir, entry)
    const text = readFileSync(file, 'utf8')
    assert.ok(text.endsWith('\n'))
    assert.ok(text.includes('x'.repeat(5000)))
  })
})
