/**
 * 同步文件集谓词（v3 布局）单测：路径匹配、fileset 解析、元数据/侧车命名、
 * 以及 resolveFilesetFiles 在真实 v3 目录上的枚举结果。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmproot } from './_tmp.js'
import {
  GLOBAL_FILESET_KEYS,
  GLOBAL_PROVENANCE_PATH,
  PROJECT_FILESET_PREFIX,
  conflictsFileFor,
  globalBranchFor,
  isKeepPath,
  isMemoryFile,
  isTodoPath,
  parseFileset,
  projectFilesetOf,
  projectProvenancePathOf,
  stageMetaOf,
} from '../lib/sync/filesets.js'
import { deviceBConnect, resolveFilesetFiles } from '../lib/sync/repo.js'

const PID = '2ddcf92a4698'
const PROJECT = projectFilesetOf(PID)

test('parseFileset：project / project:<id> / 全局轨 / 未知', () => {
  assert.equal(PROJECT_FILESET_PREFIX, 'project:')
  assert.deepEqual(parseFileset('project'), { kind: 'legacy-project' })
  assert.deepEqual(parseFileset(PROJECT), { kind: 'project', projectId: PID })
  assert.deepEqual(parseFileset('memory-global'), { kind: 'global', track: 'memory-global' })
  assert.deepEqual(GLOBAL_FILESET_KEYS, ['memory-global', 'user-global', 'daily-global', 'todo-global'])
  assert.throws(() => parseFileset('nope'), /未知同步文件集/)
  assert.throws(() => projectFilesetOf('  '), /项目 id/)
})

test('项目 fileset：记忆 / 待办 / 归档 / 日志型 / .keep（元数据单独 stage）', () => {
  const hit = [
    `memory/kb/project/${PID}/a.md`,
    `memory/kb/project/${PID}/2026-10-18/a.md`,
    `memory/kb/archive/project/${PID}/a.md`,
    `memory/key/project/${PID}/a.md`,
    `todo/global/project/${PID}/TODOS.md`,
    `todo/global/project/${PID}/2026-10-18.md`,
    `todo/global/archive/project/${PID}/TODOS.md`,
    `memory/kb/archive/project/${PID}/.keep`,
  ]
  for (const path of hit) assert.equal(isMemoryFile(path, PROJECT), true, path)

  const miss = [
    `memory/kb/global/a.md`, // 全局类不属项目轨
    `memory/kb/archive/global/a.md`,
    `memory/kb/session/abb1a330/a.md`, // 会话类不同步
    `memory/kb/project/ffffffffffff/a.md`, // 别的项目
    `todo/global/global/TODOS.md`,
    `todo/global/session/abb1a330/TODOS.md`,
    `memory/kb/project/${PID}/notes.txt`, // 非 md
    projectProvenancePathOf(PID), // 元数据不参与合并（stage 时单独加）
    '.system/groups.json',
    '.system/plugin-state.json',
    '.system/migrate-v3.state',
    GLOBAL_PROVENANCE_PATH,
  ]
  for (const path of miss) assert.equal(isMemoryFile(path, PROJECT), false, path)
  assert.equal(isKeepPath(hit[7]), true)
})

test('全局轨：按组 id 归属，自定义全局组跟随 memory-global', () => {
  const mem = (gid) => `memory/${gid}/global/a.md`
  const memArc = (gid) => `memory/${gid}/archive/global/a.md`
  const todo = (gid, name = 'TODOS.md') => `todo/${gid}/global/${name}`
  const todoArc = (gid) => `todo/${gid}/archive/global/TODOS.md`

  // memory-global：除 user/daily 外的所有全局组（含自建 custom）
  for (const gid of ['memory', 'kb', 'custom']) {
    assert.equal(isMemoryFile(mem(gid), 'memory-global'), true, gid)
    assert.equal(isMemoryFile(memArc(gid), 'memory-global'), true, gid)
    assert.equal(isMemoryFile(`memory/${gid}/archive/global/.keep`, 'memory-global'), true, gid)
  }
  assert.equal(isMemoryFile(mem('user'), 'memory-global'), false)
  assert.equal(isMemoryFile(mem('daily'), 'memory-global'), false)

  // user-global / daily-global
  assert.equal(isMemoryFile(mem('user'), 'user-global'), true)
  assert.equal(isMemoryFile(mem('kb'), 'user-global'), false)
  assert.equal(isMemoryFile(mem('daily'), 'daily-global'), true)
  assert.equal(isMemoryFile(`memory/daily/global/2026-10-18/a.md`, 'daily-global'), true)

  // todo-global
  assert.equal(isMemoryFile(todo('global'), 'todo-global'), true)
  assert.equal(isMemoryFile(todo('global', '2026-10-18.md'), 'todo-global'), true)
  assert.equal(isMemoryFile(todoArc('life'), 'todo-global'), true)
  assert.equal(isMemoryFile(mem('memory'), 'todo-global'), false)
  assert.equal(isMemoryFile(`todo/global/project/${PID}/TODOS.md`, 'todo-global'), false)

  // 仓库身份是元数据（stageMetaOf 单独加），不参与合并
  for (const track of GLOBAL_FILESET_KEYS) {
    assert.equal(isMemoryFile(GLOBAL_PROVENANCE_PATH, track), false, track)
  }
  // `.system/` 其它文件一律不入仓
  for (const path of ['.system/groups.json', '.system/legacy/x.md', '.system/projects/x/PROVENANCE']) {
    for (const track of GLOBAL_FILESET_KEYS) assert.equal(isMemoryFile(path, track), false, `${track}:${path}`)
  }
})

test('isTodoPath：v3 顶层 todo/ + v2 旧名', () => {
  assert.equal(isTodoPath(`todo/global/global/TODOS.md`), true)
  assert.equal(isTodoPath(`todo/global/global/2026-10-18.md`), true)
  assert.equal(isTodoPath(`memory/kb/global/a.md`), false)
  assert.equal(isTodoPath('TODOS.md'), true)
  assert.equal(isTodoPath('daily/2026-10-18.todo.md'), true)
  assert.equal(isTodoPath('todo/TODOS-global.md'), true)
})

test('元数据 / 侧车 / 分支命名', () => {
  // 元数据候选是「v3 位置 ∪ v2 旧位置」，调用方按 existsSync 过滤
  assert.deepEqual(stageMetaOf(PROJECT), [
    projectProvenancePathOf(PID), 'PROVENANCE',
    '.system/sync/ignore', '.gitignore', '.system/sync/attributes', '.gitattributes',
  ])
  assert.deepEqual(stageMetaOf('user-global'), [
    GLOBAL_PROVENANCE_PATH, 'PROVENANCE',
    '.system/sync/ignore', '.gitignore', '.system/sync/attributes', '.gitattributes',
  ])
  assert.deepEqual(stageMetaOf('project'), [
    'PROVENANCE', '.system/sync/ignore', '.gitignore', '.system/sync/attributes', '.gitattributes', 'CONFLICTS.md',
  ])
  assert.equal(conflictsFileFor(PROJECT), `CONFLICTS-project-${PID}.md`)
  assert.equal(conflictsFileFor('memory-global'), 'CONFLICTS-memory-global.md')
  assert.equal(conflictsFileFor('project'), 'CONFLICTS.md')
  assert.equal(globalBranchFor('memory-global'), 'dsh-shared/memory-global')
  assert.equal(globalBranchFor('todo-global'), 'dsh-shared/todo-global')
})

test('resolveFilesetFiles：真实 v3 目录按 fileset 拆分', () => {
  const dir = tmproot('dsh-sync-')
  const write = (rel) => {
    mkdirSync(join(dir, rel, '..'), { recursive: true })
    writeFileSync(join(dir, rel), '# x\n', 'utf8')
  }
  write(`memory/kb/project/${PID}/a.md`)
  write(`memory/kb/project/${PID}/2026-10-18/b.md`)
  write(`memory/kb/archive/project/${PID}/.keep`)
  write(`memory/kb/global/g.md`)
  write(`memory/user/global/u.md`)
  write(`todo/global/project/${PID}/TODOS.md`)
  write(`todo/global/global/TODOS.md`)
  write(`memory/kb/session/s1/a.md`)
  write('.system/groups.json')

  const proj = resolveFilesetFiles(dir, PROJECT)
  assert.deepEqual(proj.memory.slice().sort(), [
    `memory/kb/project/${PID}/a.md`,
    `memory/kb/project/${PID}/2026-10-18/b.md`,
    `memory/kb/archive/project/${PID}/.keep`,
  ].slice().sort())
  assert.deepEqual(proj.todo, [`todo/global/project/${PID}/TODOS.md`])

  const memGlobal = resolveFilesetFiles(dir, 'memory-global')
  assert.deepEqual(memGlobal.memory, ['memory/kb/global/g.md'])
  assert.deepEqual(memGlobal.todo, [])

  const todoGlobal = resolveFilesetFiles(dir, 'todo-global')
  assert.deepEqual(todoGlobal.todo, ['todo/global/global/TODOS.md'])

  const userGlobal = resolveFilesetFiles(dir, 'user-global')
  assert.deepEqual(userGlobal.memory, ['memory/user/global/u.md'])
})

test('walk 跳过 .git（对象库不是记忆文件）与 .system/legacy', () => {
  const dir = tmproot('dsh-sync-')
  const write = (rel, text = '# x\n') => {
    mkdirSync(join(dir, rel, '..'), { recursive: true })
    writeFileSync(join(dir, rel), text, 'utf8')
  }
  write('memory/kb/global/g.md')
  write('.git/HEAD', 'ref: refs/heads/main\n')
  write('.git/objects/ab/cd.md', 'binary-ish\n')
  write('.system/legacy/old/x.md')
  for (const fileset of ['memory-global', 'user-global', 'daily-global', 'todo-global', PROJECT]) {
    const { memory, todo } = resolveFilesetFiles(dir, fileset)
    for (const rel of [...memory, ...todo]) {
      assert.ok(!rel.startsWith('.git/'), `${fileset} 不应包含 .git 路径：${rel}`)
      assert.ok(!rel.startsWith('.system/legacy'), `${fileset} 不应包含 legacy 路径：${rel}`)
    }
  }
  assert.deepEqual(resolveFilesetFiles(dir, 'memory-global').memory, ['memory/kb/global/g.md'])
})

test('connectV3：记忆根的 .git 是文件（linked worktree/submodule）→ 拒绝且不动盘', async () => {
  const dir = tmproot('dsh-sync-')
  writeFileSync(join(dir, '.layout-version'), '3\n', 'utf8')
  writeFileSync(join(dir, '.git'), 'gitdir: C:/elsewhere/.git/worktrees/x\n', 'utf8')
  const before = readdirSync(dir).sort()
  const r = await deviceBConnect({
    dir,
    memoryDir: dir,
    fileset: `project:${PID}`,
    remoteUrl: 'https://example.com/shared-memories.git',
    remoteBranch: `dsh-shared/v3-${PID}`,
    expectedProjectId: PID,
  })
  assert.equal(r.ok, false)
  assert.match(r.message, /\.git 为文件/)
  assert.deepEqual(readdirSync(dir).sort(), before, '不得在记忆根里创建/修改任何文件')
})


