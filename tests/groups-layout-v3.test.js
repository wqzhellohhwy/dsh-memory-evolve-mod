/**
 * 布局 v3 路径层测试（规范：docs/layout-v3.md §3 / §4 / §10）。
 *
 * 覆盖：3 类 × 2 kind × daily 两态的 12 组路径断言、系统/元数据路径、
 * ctx 兼容（projectId 优先、projectDir 回退）、id 校验、daily 不可改、
 * 改名与删除统计。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  LAYOUT_VERSION,
  advisorDirOf,
  defaultGroupsConfig,
  deleteStatsOf,
  findGroup,
  groupArchiveDirOf,
  groupDirOf,
  groupsFileOf,
  isValidGroupId,
  kindRootOf,
  layoutVersionFileOf,
  legacyDirOf,
  legacyGroupsFileOf,
  loadGroups,
  memoryRootOf,
  normalizeGroupsConfig,
  projectMetaDirOf,
  renameGroupId,
  saveGroups,
  stateFileOf,
  suggestionsFileOf,
  systemDirOf,
  todoFileOf,
  todoRootOf,
  upsertGroup,
  validateGroupId,
} from '../lib/groups.js'
import { tmproot } from './_tmp.js'

/** 类段（规范 §3）。 */
const SEGMENT = { global: ['global'], project: ['project', 'p123'], session: ['session', 's456'] }

/** 12 组：klass × kind × daily。 */
for (const kind of ['memory', 'todo']) {
  for (const klass of ['global', 'project', 'session']) {
    for (const daily of [false, true]) {
      test(`v3 路径 ${kind}/${klass}/daily=${daily}`, () => {
        const dir = tmproot('dsh-memory-')
        const group = { kind, id: 'g1', klass, daily }
        const ctx = { memoryDir: dir, projectId: 'p123', sessionId: 's456', date: '2026-10-18' }
        const root = kind === 'todo' ? todoRootOf(dir) : memoryRootOf(dir)
        const seg = SEGMENT[klass]
        assert.equal(groupDirOf(group, ctx), join(root, 'g1', ...seg))
        assert.equal(groupArchiveDirOf(group, ctx), join(root, 'g1', 'archive', ...seg))
        if (kind === 'todo') {
          const file = daily ? '2026-10-18.md' : 'TODOS.md'
          assert.equal(todoFileOf(group, ctx), join(root, 'g1', ...seg, file))
        }
      })
    }
  }
}

test('系统 / 根路径全部在 memoryDir 之下', () => {
  const dir = 'C:\\mem'
  assert.equal(LAYOUT_VERSION, 3)
  assert.equal(systemDirOf(dir), join(dir, '.system'))
  assert.equal(layoutVersionFileOf(dir), join(dir, '.layout-version'))
  assert.equal(memoryRootOf(dir), join(dir, 'memory'))
  assert.equal(todoRootOf(dir), join(dir, 'todo'))
  assert.equal(kindRootOf(dir, 'memory'), join(dir, 'memory'))
  assert.equal(kindRootOf(dir, 'todo'), join(dir, 'todo'))
  assert.equal(projectMetaDirOf(dir, 'abc123'), join(dir, '.system', 'projects', 'abc123'))
  assert.equal(projectMetaDirOf(dir, ''), null)
  assert.equal(stateFileOf(dir), join(dir, '.system', 'plugin-state.json'))
  assert.equal(suggestionsFileOf(dir), join(dir, '.system', 'SUGGESTIONS.jsonl'))
  assert.equal(advisorDirOf(dir), join(dir, '.system', 'advisor'))
  assert.equal(legacyDirOf(dir), join(dir, '.system', 'legacy'))
  assert.equal(groupsFileOf(dir), join(dir, '.system', 'groups.json'))
})

test('会话 / 项目缺 id 返回 null；projectDir 末段回退为项目 id', () => {
  const dir = tmproot('dsh-memory-')
  const project = { kind: 'memory', id: 'key', klass: 'project' }
  const session = { kind: 'memory', id: 'session', klass: 'session' }
  assert.equal(groupDirOf(project, { memoryDir: dir }), null)
  assert.equal(groupDirOf(project, { memoryDir: dir, projectDir: null }), null)
  assert.equal(groupDirOf(session, { memoryDir: dir }), null)
  assert.equal(groupArchiveDirOf(project, { memoryDir: dir }), null)
  assert.equal(todoFileOf(session, { memoryDir: dir }), null)
  assert.equal(
    groupDirOf(project, { memoryDir: dir, projectDir: join(dir, '.system', 'projects', 'deadbeef') }),
    join(dir, 'memory', 'key', 'project', 'deadbeef'),
  )
})

test('id 校验：形状 / 保留字 / 同 kind 大小写不敏感唯一', () => {
  assert.equal(isValidGroupId('g1'), true)
  assert.equal(isValidGroupId('a_b-2'), true)
  assert.equal(isValidGroupId('a'.repeat(32)), true)
  assert.equal(isValidGroupId('a'.repeat(33)), false)
  assert.equal(isValidGroupId('G1'), false)
  assert.equal(isValidGroupId('-g1'), false)
  assert.equal(isValidGroupId('g.1'), false)
  assert.equal(isValidGroupId(''), false)

  assert.deepEqual(validateGroupId('g1'), { ok: true })
  assert.deepEqual(validateGroupId('g.1'), { ok: false, error: 'INVALID_ID' })
  for (const reserved of ['archive', 'memory', 'todo', 'system']) {
    assert.deepEqual(validateGroupId(reserved), { ok: false, error: 'RESERVED_ID' }, reserved)
  }
  // 内置 id（memory 组的 memory）靠 allowReserved 放行
  assert.deepEqual(validateGroupId('memory', { allowReserved: true }), { ok: true })

  const data = defaultGroupsConfig()
  const withG = normalizeGroupsConfig({ version: 2, groups: [{ kind: 'memory', id: 'g2', klass: 'global' }] })
  assert.deepEqual(validateGroupId('g2', { kind: 'memory', data: withG }), { ok: false, error: 'ID_TAKEN' })
  // 跨 kind 不冲突
  assert.deepEqual(validateGroupId('g2', { kind: 'todo', data: withG }), { ok: true })
  // 改名时排除自身
  assert.deepEqual(validateGroupId('g2', { kind: 'memory', data: withG, ignoreId: 'g2' }), { ok: true })
  assert.deepEqual(validateGroupId('g2', { kind: 'memory', data }), { ok: true })
})

test('upsertGroup：daily 变更报错，新建允许', () => {
  const data = normalizeGroupsConfig({ version: 2, groups: [{ kind: 'memory', id: 'g3', klass: 'global', daily: false }] })
  const changed = upsertGroup(data, 'memory', { id: 'g3', daily: true })
  assert.equal(changed.ok, false)
  assert.equal(changed.error, 'DAILY_FIXED')
  // 相同值视为无操作
  assert.equal(upsertGroup(data, 'memory', { id: 'g3', daily: false }).ok, true)
  // 新建时 daily 可设
  const created = upsertGroup(data, 'memory', { id: 'g4', klass: 'global', daily: true })
  assert.equal(created.ok, true)
  assert.equal(created.group.daily, true)
  // 非法 / 保留 id
  assert.equal(upsertGroup(data, 'memory', { id: 'g.1' }).error, 'INVALID_ID')
  assert.equal(upsertGroup(data, 'memory', { id: 'system' }).error, 'RESERVED_ID')
  assert.equal(upsertGroup(data, 'memory', { id: 'g3' }).ok, true)
})

test('groups.json 落在 .system/ 并可往返读写', () => {
  const dir = tmproot('dsh-memory-')
  const data = defaultGroupsConfig()
  assert.equal(saveGroups(dir, data), true)
  const loaded = loadGroups(dir)
  assert.equal(loaded.groups.length, data.groups.length)
  assert.equal(loaded.legacyFile, undefined)
  assert.equal(groupsFileOf(dir), join(dir, '.system', 'groups.json'))
  assert.equal(existsSync(legacyGroupsFileOf(dir)), false)
})

test('迁移前兼容：读旧位置 groups.json，写也留在旧位置', () => {
  const dir = tmproot('dsh-memory-')
  writeFileSync(legacyGroupsFileOf(dir), `${JSON.stringify({ version: 2, groups: [{ kind: 'memory', id: 'g9', klass: 'global' }] })}\n`, 'utf8')
  const loaded = loadGroups(dir)
  assert.equal(loaded.legacyFile, true)
  assert.ok(findGroup(loaded, 'memory', 'g9') !== null)
  // 新位置还没文件 → 继续写旧位置（单一来源）
  assert.equal(saveGroups(dir, loaded), true)
  assert.equal(existsSync(legacyGroupsFileOf(dir)), true)
  assert.equal(existsSync(groupsFileOf(dir)), false)
  // 新位置存在后，读新位置、写新位置
  mkdirSync(systemDirOf(dir), { recursive: true })
  writeFileSync(groupsFileOf(dir), `${JSON.stringify({ version: 2, groups: [{ kind: 'memory', id: 'g10', klass: 'global' }] })}\n`, 'utf8')
  assert.equal(loadGroups(dir).legacyFile, undefined)
  assert.ok(findGroup(loadGroups(dir), 'memory', 'g10') !== null)
})

test('改名：成功 / 空分组 / 目标已存在 / 内置 / 非法新 id', () => {
  const dir = tmproot('dsh-memory-')
  mkdirSync(join(dir, 'memory', 'gold', 'global'), { recursive: true })
  writeFileSync(join(dir, 'memory', 'gold', 'global', 'a.md'), '# a\n', 'utf8')

  const goldCfg = normalizeGroupsConfig({ version: 2, groups: [{ kind: 'memory', id: 'gold', klass: 'global' }] })
  const moved = renameGroupId(dir, 'memory', 'gold', 'gnew', goldCfg)
  assert.equal(moved.ok, true)
  assert.equal(moved.moved, true)
  assert.equal(moved.id, 'gnew')
  assert.equal(groupDirOf({ kind: 'memory', id: 'gnew', klass: 'global' }, { memoryDir: dir }), join(dir, 'memory', 'gnew', 'global'))
  // 旧 id 从返回配置消失、新 id 出现，且另一 kind 的分组没被丢
  assert.equal(findGroup(moved.data, 'memory', 'gold'), null)
  assert.ok(findGroup(moved.data, 'memory', 'gnew') !== null)
  assert.equal(moved.data.groups.filter((g) => g.kind === 'todo').length, defaultGroupsConfig().groups.filter((g) => g.kind === 'todo').length)

  // 空分组（配置里有、磁盘没目录）：成功且 moved=false，只改配置
  const emptyCfg = normalizeGroupsConfig({ version: 2, groups: [{ kind: 'memory', id: 'gempty', klass: 'global' }] })
  const empty = renameGroupId(dir, 'memory', 'gempty', 'gempty2', emptyCfg)
  assert.equal(empty.ok, true)
  assert.equal(empty.moved, false)
  assert.ok(findGroup(empty.data, 'memory', 'gempty2') !== null)

  // 内置拒绝
  assert.equal(renameGroupId(dir, 'memory', 'memory', 'other').error, 'BUILTIN_PROTECTED')
  // 非法 / 保留新 id
  assert.equal(renameGroupId(dir, 'memory', 'gnew', 'g.1').error, 'INVALID_ID')
  assert.equal(renameGroupId(dir, 'memory', 'gnew', 'archive').error, 'RESERVED_ID')
  // 目标已存在
  mkdirSync(join(dir, 'memory', 'gtaken'), { recursive: true })
  assert.equal(renameGroupId(dir, 'memory', 'gnew', 'gtaken').error, 'TARGET_EXISTS')
  // 配置里有、磁盘还没建的分组同样算撞名
  const config = normalizeGroupsConfig({ version: 2, groups: [
    { kind: 'memory', id: 'gnew', klass: 'global' },
    { kind: 'memory', id: 'gcfg', klass: 'global' },
  ] })
  assert.equal(renameGroupId(dir, 'memory', 'gnew', 'gcfg', config).error, 'ID_TAKEN')
  // 磁盘与配置都不存在 → NOT_FOUND
  assert.equal(renameGroupId(dir, 'memory', 'nope', 'nope2').error, 'NOT_FOUND')
})

test('删除统计：entries / archived / locations', () => {
  const dir = tmproot('dsh-memory-')
  const base = join(dir, 'memory', 'g1')
  mkdirSync(join(base, 'global'), { recursive: true })
  writeFileSync(join(base, 'global', 'a.md'), '# a\n', 'utf8')
  for (const pid of ['p1', 'p2']) {
    mkdirSync(join(base, 'project', pid), { recursive: true })
    writeFileSync(join(base, 'project', pid, 'x.md'), '# x\n', 'utf8')
  }
  mkdirSync(join(base, 'session', 's1'), { recursive: true })
  writeFileSync(join(base, 'session', 's1', 'y.md'), '# y\n', 'utf8')
  mkdirSync(join(base, 'archive', 'global'), { recursive: true })
  writeFileSync(join(base, 'archive', 'global', 'z.md'), '# z\n', 'utf8')

  assert.deepEqual(deleteStatsOf(dir, 'memory', 'g1'), { entries: 4, archived: 1, locations: 3 })
  // 空目录 → 全 0
  assert.deepEqual(deleteStatsOf(dir, 'memory', 'missing'), { entries: 0, archived: 0, locations: 0 })
})
