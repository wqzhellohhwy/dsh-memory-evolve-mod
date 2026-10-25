/**
 * 页内常驻错误行（加载失败 + 重试）。
 *
 * 与 toast 的分工：toast 只报**一次性结果**（保存/删除/失败）；整页加载失败会让
 * 面板空着、控件全禁用，用户需要一个一直看得见的说明和重新加载入口，所以走
 * 页内常驻条（`me-notice me-notice-error` + 「重试」）。
 */
export interface InlineErrorProps {
  text: string
  retryText: string
  onRetry: () => void
}

export function InlineError(props: InlineErrorProps): JSX.Element {
  return (
    <div className="me-notice me-notice-error" role="alert">
      <span className="me-notice-text">{props.text}</span>
      <button type="button" className="me-btn me-notice-action" onClick={props.onRetry}>
        {props.retryText}
      </button>
    </div>
  )
}
