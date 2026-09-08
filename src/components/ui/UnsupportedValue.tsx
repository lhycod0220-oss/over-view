/**
 * 게이트웨이 API 가 제공하지 않는 값을 표시하는 자리표시자.
 *
 * 기압 · RSSI · 배터리 · 가동시간은 백엔드/펌웨어 어디에도 없습니다
 * (docs/CONTRACT-DIFF.md 2-1절). 값을 0 이나 "-" 로 보여주면 실측처럼 오해되므로,
 * "왜 없는지"까지 함께 드러냅니다. mock 모드에서는 실제 값이 있어 이 컴포넌트가 쓰이지 않습니다.
 */
export function UnsupportedValue({ reason }: { reason?: string }) {
  return (
    <span
      className="mono"
      style={{
        fontSize: 12,
        color: "var(--text-tertiary)",
        fontStyle: "italic",
        whiteSpace: "nowrap",
      }}
      title={
        reason
          ? `게이트웨이 API 가 이 값을 제공하지 않습니다 — ${reason}`
          : "게이트웨이 API 가 이 값을 제공하지 않습니다"
      }
    >
      데이터 없음
      <span style={{ fontSize: 10, marginLeft: 4, fontStyle: "normal" }}>(백엔드 미지원)</span>
    </span>
  );
}
