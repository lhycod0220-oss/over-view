const INTERVAL_OPTIONS = [1, 5, 10, 30, 60];

interface ExportTarget {
  nodeId: string;
  label: string;
}

export function ExperimentControlPanel({
  activeIntervalS,
  applyingInterval,
  onSetInterval,
  onTruncate,
  truncating,
  truncateUnsupported = false,
  onExportCsv,
  exportingNodeId,
  statusLabel,
  statusColor,
  exportTargets,
  exportNote = null,
}: {
  activeIntervalS: number | null;
  applyingInterval: boolean;
  onSetInterval: (seconds: number) => void;
  onTruncate: () => void;
  truncating: boolean;
  /** 게이트웨이에 truncate 엔드포인트가 없는 경우 버튼을 잠급니다. */
  truncateUnsupported?: boolean;
  onExportCsv: (nodeId: string) => void;
  exportingNodeId: string | null;
  statusLabel: string;
  statusColor: string;
  exportTargets: ExportTarget[];
  /** CSV 내보내기 동작의 제약을 알리는 한 줄 안내. */
  exportNote?: string | null;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <div>
        <div style={{ fontSize: 12, color: "var(--text-secondary)", marginBottom: 8 }}>
          전송 주기 (두 보드 동시 적용)
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {INTERVAL_OPTIONS.map((s) => {
            const active = activeIntervalS === s;
            return (
              <button
                key={s}
                className="btn"
                disabled={applyingInterval}
                onClick={() => onSetInterval(s)}
                style={{
                  borderColor: active ? "var(--signal-teal)" : "var(--border-hair-strong)",
                  background: active ? "var(--bg-panel-raised)" : "var(--bg-inset)",
                }}
              >
                {s}초
              </button>
            );
          })}
          {applyingInterval && (
            <span style={{ fontSize: 12, color: "var(--text-tertiary)", alignSelf: "center" }}>적용 중…</span>
          )}
        </div>
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center" }}>
        <button
          className="btn"
          disabled={truncating || truncateUnsupported}
          onClick={onTruncate}
          title={
            truncateUnsupported
              ? "게이트웨이에 로그 초기화 엔드포인트가 없습니다 (docs/CONTRACT-DIFF.md 1절)"
              : undefined
          }
        >
          {truncating ? "초기화 중…" : "로그 초기화 (Truncate)"}
          {truncateUnsupported && (
            <span style={{ fontSize: 10, marginLeft: 6, color: "var(--text-tertiary)" }}>
              백엔드 미지원
            </span>
          )}
        </button>

        {exportTargets.map((t) => (
          <button
            key={t.nodeId}
            className="btn btn-primary"
            disabled={exportingNodeId !== null}
            onClick={() => onExportCsv(t.nodeId)}
          >
            {exportingNodeId === t.nodeId ? "내보내는 중…" : `${t.label} CSV 다운로드`}
          </button>
        ))}

        <span className="tag" style={{ borderColor: statusColor, color: statusColor, marginLeft: "auto" }}>
          <span className="dot" style={{ background: statusColor }} />
          {statusLabel}
        </span>
      </div>

      {exportNote && (
        <div style={{ fontSize: 11, color: "var(--text-tertiary)", marginTop: -8 }}>{exportNote}</div>
      )}
    </div>
  );
}
