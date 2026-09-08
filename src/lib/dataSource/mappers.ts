/**
 * 백엔드 원본 응답 → 프런트 도메인 타입 변환을 **한곳에 격리**합니다.
 *
 * 백엔드(Kwak-min/MQTT `backend/`)가 프런트 가정과 다른 지점은 전부 여기서 흡수합니다:
 *
 *  1. snake_case → camelCase                 (백엔드는 camelCase 를 만들지 않음)
 *  2. 문자열 → 숫자                           (`/api/v1/logs/*` 는 csv.DictReader 결과라 전부 문자열)
 *  3. `"True"` / `"False"` → boolean          (Python bool 의 str(). `Boolean("False")` 는 true 라 그냥 쓰면 안 됨)
 *  4. 오프셋 없는 로컬시각 → ISO 8601 + 오프셋  (`time.strftime("%Y-%m-%dT%H:%M:%S")`)
 *  5. Unix epoch(float) → ISO 8601            (세션의 connected_at / last_seen)
 *  6. `""`(CSV 왕복된 None) → undefined
 *  7. 0.0 으로 채워진 "미수신" 스냅샷 걸러내기   (백엔드는 404 대신 200 + 기본값을 줌)
 *
 * 근거: docs/CONTRACT-DIFF.md 2절·4절.
 */

import type {
  ControlResult,
  DeviceState,
  FirmwareVariant,
  GatewayConfig,
  NodeInfo,
  NodeRole,
  PowerSample,
  ProtocolStats,
  SessionStatus,
  SessionSummary,
  TelemetrySample,
} from "./types";

/** 백엔드가 돌려주는 임의 JSON 객체. 값 타입을 신뢰할 수 없어 unknown 으로 받습니다. */
export type RawRow = Record<string, unknown>;

// ─────────────────────────────────────────────────────────────────────────────
// 노드 식별 — 백엔드에 firmware/role 필드가 없어 client_id 로 판별합니다.
// docs/CONTRACT-DIFF.md 5절.
// ─────────────────────────────────────────────────────────────────────────────

export const CLIENT_ID_GINGERBREAD = "ESP32-Gingerbread";
export const CLIENT_ID_STANDARD_MQTT = "ESP32-Standard-MQTT";
export const CLIENT_ID_MONITOR = "ESP32-Power-Monitor";
/** 백엔드가 (addr_ip, addr_port) 세션 역조회에 실패했을 때 채우는 값. */
export const CLIENT_ID_UNKNOWN = "unknown";

interface NodeProfile {
  name: string;
  firmware: FirmwareVariant;
  role: NodeRole;
  ingestPath: NodeInfo["ingestPath"];
}

const NODE_PROFILES: Record<string, NodeProfile> = {
  [CLIENT_ID_GINGERBREAD]: {
    name: "Gingerbread",
    firmware: "gingerbread",
    role: "primary",
    ingestPath: "udp",
  },
  [CLIENT_ID_STANDARD_MQTT]: {
    name: "Standard MQTT",
    firmware: "standard_mqtt",
    role: "baseline",
    ingestPath: "mqtt",
  },
  // 펌웨어는 UDP 5001 로 보내는데 백엔드는 5001 을 듣지 않아 실제로는 나타나지 않습니다.
  [CLIENT_ID_MONITOR]: {
    name: "Power Monitor",
    firmware: "monitor",
    role: "primary",
    ingestPath: "udp",
  },
};

/** client_id 문자열로 NodeInfo 를 만듭니다. 모르는 값이면 unknown 노드로 취급합니다. */
export function nodeInfoFromClientId(clientId: string): NodeInfo {
  const profile = NODE_PROFILES[clientId];
  if (profile) {
    return { nodeId: clientId, ...profile };
  }
  const isUnidentified = clientId === CLIENT_ID_UNKNOWN;
  return {
    nodeId: clientId,
    name: isUnidentified ? "식별 실패 (unknown)" : clientId,
    firmware: "unknown",
    role: "unknown",
    ingestPath: "unknown",
    isUnidentified: true,
  };
}

/** 비교 대시보드가 기본으로 기대하는 두 노드. 세션이 아직 없어도 화면이 뜨도록 씨앗으로 씁니다. */
export const KNOWN_NODE_IDS = [CLIENT_ID_GINGERBREAD, CLIENT_ID_STANDARD_MQTT];

// ─────────────────────────────────────────────────────────────────────────────
// 원시값 강제 변환 (coercion)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 숫자로 변환합니다. CSV 왕복으로 문자열이 된 값("25.30")도 처리합니다.
 * 값이 없거나(`null`/`undefined`), CSV 의 빈 문자열이거나, 숫자가 아니면 undefined.
 */
export function toNumber(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string") {
    const trimmed = value.trim();
    // 백엔드가 None 을 쓴 칸은 CSV 왕복 후 "" 로 돌아옵니다.
    if (trimmed === "" || trimmed === "None") return undefined;
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

/** toNumber 와 같되 값이 없으면 fallback 을 씁니다. */
export function toNumberOr(value: unknown, fallback: number): number {
  return toNumber(value) ?? fallback;
}

/**
 * boolean 으로 변환합니다.
 * 백엔드 CSV 는 Python `str(True)` 결과인 `"True"` / `"False"` 를 돌려주므로
 * `Boolean(v)` 를 그대로 쓰면 `"False"` 가 true 가 됩니다.
 */
export function toBool(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    return v === "true" || v === "1";
  }
  return false;
}

/** 문자열로 변환합니다. 빈 문자열/None 은 undefined 로 접습니다. */
export function toText(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  const s = String(value).trim();
  if (s === "" || s === "None") return undefined;
  return s;
}

/** QoS 는 0/1/2 만 유효합니다. 그 밖의 값은 0 으로 떨굽니다. */
export function toQos(value: unknown): 0 | 1 | 2 {
  const n = toNumber(value);
  return n === 1 || n === 2 ? n : 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// 시각 변환
// ─────────────────────────────────────────────────────────────────────────────

const OFFSET_PATTERN = /(?:Z|[+-]\d{2}:?\d{2})$/;

/**
 * 게이트웨이 타임존 오프셋. 백엔드가 오프셋 없는 로컬시각을 주기 때문에 필요합니다.
 * `VITE_GATEWAY_TZ_OFFSET` 이 비어 있으면 브라우저 로컬 시간대로 해석합니다
 * (게이트웨이와 브라우저가 같은 시간대일 때만 맞습니다).
 */
function gatewayOffset(): string | null {
  const raw = import.meta.env.VITE_GATEWAY_TZ_OFFSET?.trim();
  if (!raw) return null;
  return OFFSET_PATTERN.test(raw) ? raw : null;
}

/**
 * 백엔드의 `"2026-09-08T16:41:07"` (오프셋 없음·밀리초 없음·로컬시각) 을
 * ISO 8601 + 오프셋 문자열로 정규화합니다.
 * 이미 오프셋이 붙어 있으면 그대로 둡니다.
 */
export function naiveLocalToIso(value: unknown): string | undefined {
  const raw = toText(value);
  if (!raw) return undefined;
  if (OFFSET_PATTERN.test(raw)) return raw;

  const offset = gatewayOffset();
  if (offset) return `${raw}${offset}`;

  // 오프셋 설정이 없으면 브라우저 로컬 시간대로 해석해 ISO 로 되돌립니다.
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? raw : d.toISOString();
}

/** Unix epoch(초, float) → ISO 8601. 세션의 connected_at / last_seen 용. */
export function epochToIso(value: unknown): string | undefined {
  const seconds = toNumber(value);
  if (seconds === undefined) return undefined;
  const d = new Date(seconds * 1000);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

// ─────────────────────────────────────────────────────────────────────────────
// 봉투 언랩 — 백엔드 응답은 대부분 봉투에 싸여 옵니다.
// ─────────────────────────────────────────────────────────────────────────────

/** `{count, data:[...]}` / `{count, sessions:[...]}` 형태에서 배열만 꺼냅니다. */
export function unwrapList(payload: unknown, key: "data" | "sessions"): RawRow[] {
  if (Array.isArray(payload)) return payload as RawRow[];
  if (payload && typeof payload === "object") {
    const inner = (payload as Record<string, unknown>)[key];
    if (Array.isArray(inner)) return inner as RawRow[];
  }
  return [];
}

/** `{status, config:{...}}` 에서 config 만 꺼냅니다. */
export function unwrapObject(payload: unknown, key: string): RawRow {
  if (payload && typeof payload === "object") {
    const inner = (payload as Record<string, unknown>)[key];
    if (inner && typeof inner === "object") return inner as RawRow;
  }
  return {};
}

// ─────────────────────────────────────────────────────────────────────────────
// 미수신 판정
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 백엔드는 첫 패킷 전에도 404 대신 **센서값이 0.0 으로 채워진 200** 을 돌려줍니다.
 * 메타 필드는 정직하게 null 이므로 그것으로 "아직 데이터 없음" 을 판정합니다.
 * 이 가드가 없으면 0°C / 0% 를 실측처럼 표시하게 됩니다.
 *
 * 판정식은 **긍정 신호의 OR** 입니다 — 어떤 조건도 데이터를 "배제"하지 않습니다.
 */
export function hasTelemetryData(row: RawRow | null | undefined): boolean {
  if (!row) return false;

  // 1차 기준 — timestamp 가 존재하고 실제로 파싱 가능해야 합니다.
  // 빈 스냅샷의 timestamp 는 null 이고, 실측 행은 항상 값이 있습니다.
  if (isParsableTimestamp(row.timestamp)) return true;

  // 보조 기준 — 백엔드 인메모리 스냅샷에만 있는 **게이트웨이 누적 수신 카운터**입니다
  // (`telemetry_service.telemetry_data["packet_count"] += 1`).
  //
  // 주의: power.csv 의 동명 필드(펌웨어 `pkt`)와 다릅니다. 그쪽은 Gingerbread 가
  // 보내지 않아 항상 0 이지만, 환경 텔레메트리 행에는 `_ENV_FIELDS` 에 packet_count 가
  // 아예 없으므로 이 값으로 노드를 배제하면 안 됩니다 — 어디까지나 보조 신호일 뿐,
  // 0 이라고 해서 "미수신"으로 판정하지 않습니다.
  return toNumberOr(row.packet_count, 0) > 0;
}

/** 값이 있고 Date 로 파싱되는 timestamp 인지 확인합니다. */
function isParsableTimestamp(value: unknown): boolean {
  const raw = toText(value);
  if (!raw) return false;
  return !Number.isNaN(new Date(raw).getTime());
}

// ─────────────────────────────────────────────────────────────────────────────
// 행 매퍼
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 환경 텔레메트리 1행 → TelemetrySample.
 *
 * 대상: `/api/telemetry/env` · `/api/telemetry/latest/env` · `/api/v1/logs/telemetry`
 *       · WebSocket `{type:"telemetry"}` 의 `data`.
 *
 * `gas` 는 펌웨어가 **kΩ** 로 보냅니다 — Ω 가 아니므로 나누지 않습니다.
 * `deviceState` 는 이 응답에 없어 호출부가 세션 테이블에서 채워 넣습니다.
 *
 * ⚠ `estimated_energy_mwh` 는 **의도적으로 읽지 않습니다.**
 * WebSocket 이 이 필드를 텔레메트리에 병합해 주긴 하지만, 백엔드
 * `_extract_estimated_energy()` 가 노드 구분 없이 "첫 번째로 발견된" 스냅샷 값을
 * 넣기 때문에 그 패킷을 보낸 노드의 값이라는 보장이 없습니다
 * (docs/CONTRACT-DIFF.md 3절·6절). 노드별 에너지 비교/집계는 반드시
 * `client_id` 로 필터한 `/api/v1/logs/power` → `mapPowerRow()` 경로만 쓰세요.
 * TelemetrySample 에 에너지 필드를 추가하지 마십시오.
 */
export function mapTelemetryRow(row: RawRow): TelemetrySample {
  return {
    msgId: toNumberOr(row.msg_id, 0),
    nodeId: toText(row.client_id) ?? CLIENT_ID_UNKNOWN,
    timestamp: naiveLocalToIso(row.timestamp) ?? new Date().toISOString(),
    temperatureC: toNumberOr(row.temp, 0),
    humidityPct: toNumberOr(row.hum, 0),
    gasResistanceKohm: toNumberOr(row.gas, 0),
    gasValid: toBool(row.gas_valid),
    qos: toQos(row.qos),
    topicId: toNumber(row.topic_id),
    addrIp: toText(row.addr_ip) ?? null,
    addrPort: toNumber(row.addr_port) ?? null,
    rawPayload: toText(row.raw_payload),
    // pressureHpa / rssiDbm / batteryV / uptimeS 는 백엔드 미지원 → 채우지 않습니다.
  };
}

/**
 * 전력 1행 → PowerSample.
 * 대상: `/api/v1/logs/power` (CSV 문자열).
 */
export function mapPowerRow(row: RawRow): PowerSample {
  return {
    timestamp: naiveLocalToIso(row.timestamp) ?? new Date().toISOString(),
    nodeId: toText(row.client_id) ?? CLIENT_ID_UNKNOWN,
    qos: toQos(row.qos),
    rttMs: toNumberOr(row.rtt_ms, 0),
    retryCount: toNumberOr(row.retry_count, 0),
    sleepModeRatio: toNumberOr(row.sleep_mode_ratio, 0),
    energyMwh: toNumberOr(row.estimated_energy_mwh, 0),
    packetCount: toNumberOr(row.packet_count, 0),
    totalBytes: toNumberOr(row.total_bytes, 0),
    // voltageV / currentMa / powerMw / estimatedBatteryPct / msgId / isConnectionSpike 는
    // 백엔드 미지원(또는 0 하드코딩) → 채우지 않습니다.
  };
}

const SESSION_STATUS_MAP: Record<string, SessionStatus> = {
  ACTIVE: "active",
  ASLEEP: "asleep",
  TIMED_OUT: "timed_out",
};

/** 세션 1행 → SessionSummary. 대상: `/api/sessions`, `/api/sessions/{client_id}`. */
export function mapSessionRow(row: RawRow): SessionSummary {
  const clientId = toText(row.client_id) ?? CLIENT_ID_UNKNOWN;
  const rawStatus = (toText(row.status) ?? "").toUpperCase();
  const nowIso = new Date().toISOString();
  return {
    nodeId: clientId,
    // 알 수 없는 status 를 timed_out 으로 떨굴면 정상 노드가 "응답 없음"으로 보입니다 — unknown 으로 두고 색상만 중립화합니다.
    status: SESSION_STATUS_MAP[rawStatus] ?? "unknown",
    addrIp: toText(row.addr_ip) ?? null,
    addrPort: toNumber(row.addr_port) ?? null,
    connectedAt: epochToIso(row.connected_at) ?? nowIso,
    lastSeen: epochToIso(row.last_seen) ?? nowIso,
    packetCount: toNumberOr(row.packet_count, 0),
    // protocol 은 백엔드 미지원이지만 client_id 로 확실히 유도되므로 채워 줍니다.
    protocol: clientId === CLIENT_ID_STANDARD_MQTT ? "mqtt" : "udp",
  };
}

/**
 * 세션 상태 → 단말 duty-cycle 상태.
 * 텔레메트리에는 device_state 가 없어 세션 테이블에서 유도합니다.
 * `TIMED_OUT` 은 active/asleep 어느 쪽도 아니므로 undefined 로 둡니다.
 */
export function deviceStateFromSession(status: SessionStatus | undefined): DeviceState | undefined {
  if (status === "active") return "active";
  if (status === "asleep") return "asleep";
  return undefined;
}

/** `GET /api/config` → GatewayConfig. 3개 섹션으로 중첩돼 있습니다. */
export function mapGatewayConfig(config: RawRow): GatewayConfig {
  const network = (config.NETWORK ?? {}) as RawRow;
  const environment = (config.ENVIRONMENT ?? {}) as RawRow;
  const power = (config.POWER_MANAGEMENT ?? {}) as RawRow;
  return {
    rssiThreshold: toNumberOr(network.RSSI_THRESHOLD, 0),
    packetLossLimit: toNumberOr(network.PACKET_LOSS_LIMIT, 0),
    gasThresholdKohm: toNumberOr(environment.GAS_THRESHOLD_KOHM, 0),
    tempThresholdCelsius: toNumberOr(environment.TEMP_THRESHOLD_CELSIUS, 0),
    powerMode: toText(power.POWER_MODE) ?? "EXTERNAL_5V",
    currentBatteryLevel: toNumberOr(power.CURRENT_BATTERY_LEVEL, 0),
  };
}

/**
 * GatewayConfig 부분 수정 → `POST /api/config` 본문.
 * 백엔드는 플랫 JSON 도 받아주므로 플랫으로 보냅니다.
 */
export function gatewayConfigToBody(patch: Partial<GatewayConfig>): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (patch.rssiThreshold !== undefined) body.RSSI_THRESHOLD = patch.rssiThreshold;
  if (patch.packetLossLimit !== undefined) body.PACKET_LOSS_LIMIT = patch.packetLossLimit;
  if (patch.gasThresholdKohm !== undefined) body.GAS_THRESHOLD_KOHM = patch.gasThresholdKohm;
  if (patch.tempThresholdCelsius !== undefined) {
    body.TEMP_THRESHOLD_CELSIUS = patch.tempThresholdCelsius;
  }
  if (patch.powerMode !== undefined) body.POWER_MODE = patch.powerMode;
  if (patch.currentBatteryLevel !== undefined) {
    body.CURRENT_BATTERY_LEVEL = patch.currentBatteryLevel;
  }
  return body;
}

/**
 * `GET /api/diagnostics` → ProtocolStats.
 * qos 블록과 gingerbread 리스너 메트릭을 합칩니다 — **전역 집계**입니다.
 */
export function mapDiagnostics(payload: RawRow, nodeId: string): ProtocolStats {
  const qos = (payload.qos ?? {}) as RawRow;
  const listeners = (payload.listeners ?? {}) as RawRow;
  const gingerbread = (listeners.gingerbread ?? {}) as RawRow;
  return {
    nodeId,
    windowLabel: "게이트웨이 전역 누적",
    totalDelivered: toNumberOr(qos.total_delivered, 0),
    pendingQos2Count: toNumberOr(qos.pending_qos2_count, 0),
    totalPubackSent: toNumberOr(qos.total_puback_sent, 0),
    totalPubrecSent: toNumberOr(qos.total_pubrec_sent, 0),
    totalPubcompSent: toNumberOr(qos.total_pubcomp_sent, 0),
    totalQos2Expired: toNumberOr(qos.total_qos2_expired, 0),
    recvCount: toNumberOr(gingerbread.recv_count, 0),
    errorCount: toNumberOr(gingerbread.error_count, 0),
    listenerAlive: toBool(gingerbread.is_alive),
  };
}

/** `POST /api/v1/control` 응답 → ControlResult. */
export function mapControlResult(payload: RawRow): ControlResult {
  return {
    status: toText(payload.status) ?? "ok",
    msgId: toNumberOr(payload.msg_id, 0),
    packetSize: toNumberOr(payload.packet_size, 0),
    target: toText(payload.target) ?? "",
    message: toText(payload.message) ?? "",
    timestamp: naiveLocalToIso(payload.timestamp) ?? new Date().toISOString(),
  };
}
