import { formatEnergyMwh } from "@/lib/format";

interface EnergyBar {
  label: string;
  color: string;
  /** 누적 에너지 (mWh) — 백엔드 estimated_energy_mwh 와 같은 단위 */
  valueMwh: number;
}

export function EnergyBarCompare({ bars }: { bars: EnergyBar[] }) {
  // 누적 mWh 는 회당 μWh 수준이 쌓인 값이라 1 을 하한으로 두면 막대가 전부 눌립니다.
  // 0 나눗셈만 막고 실제 최댓값을 기준으로 삼습니다.
  const max = Math.max(...bars.map((b) => b.valueMwh), Number.EPSILON);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {bars.map((bar) => {
        const pct = Math.max((bar.valueMwh / max) * 100, 2);
        return (
          <div key={bar.label}>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                fontSize: 12,
                marginBottom: 6,
                color: "var(--text-secondary)",
              }}
            >
              <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span className="dot" style={{ background: bar.color }} />
                {bar.label}
              </span>
              <span className="mono" style={{ color: "var(--text-primary)" }}>
                {formatEnergyMwh(bar.valueMwh)}
              </span>
            </div>
            <div
              style={{
                height: 10,
                borderRadius: 999,
                background: "var(--bg-inset)",
                overflow: "hidden",
                border: "1px solid var(--border-hair)",
              }}
            >
              <div
                style={{
                  width: `${pct}%`,
                  height: "100%",
                  background: bar.color,
                  borderRadius: 999,
                  transition: "width 300ms ease",
                }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}
