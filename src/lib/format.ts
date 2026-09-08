import type { DeviceState, FirmwareVariant, SessionStatus } from "./dataSource/types";

/**
 * 가스 저항: 펌웨어가 **kΩ 로 전송**하므로 그대로 표시합니다.
 * (예전에는 Ω 로 가정해 1000 으로 나눴는데, 그러면 값이 1000배 작게 나옵니다 —
 *  docs/CONTRACT-DIFF.md 2-1절)
 */
export function formatGasResistance(kohm: number): string {
  return `${kohm.toFixed(1)} kΩ`;
}

export function formatTemperature(celsius: number): string {
  return `${celsius.toFixed(1)}°C`;
}

export function formatHumidity(pct: number): string {
  return `${pct.toFixed(1)}%`;
}

export function formatPressure(hpa: number): string {
  return `${hpa.toFixed(1)} hPa`;
}

export function formatRssi(dbm: number): string {
  return `${dbm.toFixed(0)} dBm`;
}

export function formatVoltage(v: number): string {
  return `${v.toFixed(3)} V`;
}

export function formatCurrent(ma: number): string {
  return `${ma.toFixed(1)} mA`;
}

export function formatPower(mw: number): string {
  return `${mw.toFixed(0)} mW`;
}

/** 1 mWh = 3600 mJ. 백엔드는 mWh 로 주므로 mJ 표시가 필요할 때만 환산합니다. */
export const MJ_PER_MWH = 3600;

/**
 * 1회 통신 에너지 표시. 백엔드 값이 mWh 단위인데 회당 소모가 μWh 수준이라
 * 그대로 쓰면 0.00 만 보입니다 — 읽기 쉬운 mJ 로 환산해 보여줍니다.
 */
export function formatEnergyPerMessage(mwh: number): string {
  return `${(mwh * MJ_PER_MWH).toFixed(1)} mJ`;
}

/** 누적 에너지는 mWh 단위 그대로 표시합니다. */
export function formatEnergyMwh(mwh: number): string {
  return `${mwh.toFixed(3)} mWh`;
}

export function formatUptime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}시간 ${m}분`;
  return `${m}분`;
}

/** ISO 8601 + 오프셋 문자열을 화면용 절대 시간으로 변환 */
export function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString("ko-KR", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

export function formatRelativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const diffS = Math.round(diffMs / 1000);
  if (diffS < 5) return "방금";
  if (diffS < 60) return `${diffS}초 전`;
  const diffM = Math.round(diffS / 60);
  if (diffM < 60) return `${diffM}분 전`;
  const diffH = Math.round(diffM / 60);
  if (diffH < 24) return `${diffH}시간 전`;
  return `${Math.round(diffH / 24)}일 전`;
}

export const FIRMWARE_LABEL: Record<FirmwareVariant, string> = {
  standard_mqtt: "Standard MQTT",
  monitor: "Monitor",
  gingerbread: "Gingerbread",
  unknown: "식별 실패",
};

export const FIRMWARE_COLOR: Record<FirmwareVariant, string> = {
  standard_mqtt: "var(--signal-teal)",
  monitor: "var(--signal-amber)",
  gingerbread: "var(--signal-violet)",
  unknown: "var(--text-tertiary)",
};

export const DEVICE_STATE_LABEL: Record<DeviceState, string> = {
  active: "ACTIVE",
  asleep: "ASLEEP",
};

export const DEVICE_STATE_COLOR: Record<DeviceState, string> = {
  active: "var(--signal-green)",
  asleep: "var(--text-tertiary)",
};

/** 백엔드 세션 상태 (`app/models/session.py`). */
export const SESSION_STATUS_LABEL: Record<SessionStatus, string> = {
  active: "수신 중",
  asleep: "수면 중",
  timed_out: "응답 없음",
  unknown: "상태 미상",
};

export const SESSION_STATUS_COLOR: Record<SessionStatus, string> = {
  active: "var(--signal-green)",
  asleep: "var(--signal-amber)",
  timed_out: "var(--signal-red)",
  unknown: "var(--text-tertiary)",
};
