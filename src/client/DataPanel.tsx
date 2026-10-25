/**
 * dsh-memory-evolve — 配置页「数据」二级页（2026-10-15）。
 *
 * 展示并操作存储层本身：当前存储格式版本、待迁移的旧格式文件数、记忆根目录，
 * 以及迁移的执行与回滚。
 *
 * 背景：2026-10-15 起存储从「一个分组一个 .md（条目用 § 分隔）」升级为
 * 「一条记忆一个 md + frontmatter 元数据 + 按类分目录」。插件加载时会自动
 * 跑一次迁移，这里给出同一入口的手动触发、试运行与回滚，让用户随时能看清
 * 数据在哪、能不能退回去。
 */
import { useCallback, useEffect, useState } from 'react'
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'

interface VaultStatus {
  version: number
  needsMigration: boolean
  legacyFiles: number
  backups: string[]
  memoryDir?: string
}

interface MigrateReport {
  ok: boolean
  entries: number
  todos: number
  files: number
  backup: string | null
  skipped: number
  errors: string[]
  dryRun: boolean
}

/** 配置页「数据」页。 */
export function DataPanel(props: { t: Translate }): JSX.Element {
  const { t } = props
  const [status, setStatus] = useState<VaultStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [report, setReport] = useState<MigrateReport | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(() => {
    fetch('/memory-evolve/api/vault/status')
      .then((res) => res.json())
      .then((data: VaultStatus) => { setStatus(data) })
      .catch(() => { setError(String(t('settingsTab.data.statusFailed'))) })
  }, [t])

  useEffect(() => { load() }, [load])

  const migrate = useCallback((dryRun: boolean) => {
    setBusy(true)
    setError(null)
    fetch('/memory-evolve/api/vault/migrate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dryRun }),
    })
      .then((res) => res.json())
      .then((data: MigrateReport) => {
        setReport(data)
        load()
      })
      .catch(() => { setError(String(t('settingsTab.data.migrateFailed'))) })
      .finally(() => { setBusy(false) })
  }, [load, t])

  const rollback = useCallback((backup: string) => {
    setBusy(true)
    setError(null)
    fetch('/memory-evolve/api/vault/rollback', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ backup }),
    })
      .then((res) => res.json())
      .then(() => { load() })
      .catch(() => { setError(String(t('settingsTab.data.rollbackFailed'))) })
      .finally(() => { setBusy(false) })
  }, [load, t])

  if (status === null) return <div className="me-hint">{t('settingsTab.configLoading')}</div>

  return (
    <div className="me-block">
      {error !== null && <p className="me-error">{error}</p>}
      <p className="me-hint">
        {t('settingsTab.data.versionLine', {
          version: String(status.version),
          expected: '2',
        })}
      </p>
      {status.memoryDir !== undefined && (
        <p className="me-hint">{t('settingsTab.data.dirLine', { dir: status.memoryDir })}</p>
      )}
      <p className="me-hint">
        {status.needsMigration
          ? t('settingsTab.data.pending', { count: String(status.legacyFiles) })
          : t('settingsTab.data.upToDate')}
      </p>

      <div style={{ display: 'flex', gap: '8px', margin: '10px 0' }}>
        <button
          type="button"
          className="me-btn"
          disabled={busy}
          onClick={() => migrate(true)}
        >
          {t('settingsTab.data.dryRun')}
        </button>
        <button
          type="button"
          className="me-btn me-btn-primary"
          disabled={busy || !status.needsMigration}
          onClick={() => migrate(false)}
        >
          {t('settingsTab.data.migrate')}
        </button>
      </div>

      {report !== null && (
        <p className="me-hint">
          {t('settingsTab.data.report', {
            files: String(report.files),
            entries: String(report.entries),
            todos: String(report.todos),
            backup: report.backup ?? '—',
          })}
          {report.errors.length > 0 && ` ｜ ${report.errors.join('；')}`}
        </p>
      )}

      {status.backups.length > 0 && (
        <>
          <p className="me-field-sub">{t('settingsTab.data.backups')}</p>
          {status.backups.map((backup) => (
            <div className="me-field" key={backup}>
              <span className="me-field-label" style={{ wordBreak: 'break-all' }}>{backup}</span>
              <button
                type="button"
                className="me-btn me-btn-archive"
                disabled={busy}
                onClick={() => rollback(backup)}
              >
                {t('settingsTab.data.rollback')}
              </button>
            </div>
          ))}
        </>
      )}
    </div>
  )
}
