/**
 * 도메인 타입.
 *
 * 이 타입들은 백엔드(Kwak-min/MQTT `backend/`)의 **실제 응답 스펙**을 반영합니다.
 * 프런트 가정과 백엔드 실제의 전체 차이는 docs/CONTRACT-DIFF.md 에 정리되어 있습니다.
 *
 * 규칙
 * ────
 * - 백엔드는 전부 snake_case 로 응답합니다. camelCase 변환은 `mappers.ts` 한곳에서만 합니다.
 * - `백엔드 미지원` 주석이 붙은 필드는 게이트웨이 API/펌웨어에 존재하지 않아
 *   http 모드에서는 항상 `undefined` 입니다. mock 모드에서만 값이 채워지므로,
 *   화면에서는 반드시 optional 로 다루고 없으면 "데이터 없음(백엔드 미지원)" 을 표시하세요.
 */

/** `client_id` 값으로 판별합니다 — 백엔드에 firmware 필드는 없습니다. */
export type FirmwareVariant = "standard_mqtt" | "monitor" | "gingerbread" | "unknown";

export type NodeRole = "primary" | "baseline" | "unknown";

export type ConnectionState = "connected" | "connecting" | "disconnected" | "error";

/** Gingerbread 전용 duty-cycle 동작 상태. 세션 테이블 status 에서 유도합니다. */
export type DeviceState = "active" | "asleep";

export interface NodeInfo {
  /** http 모드에서는 백엔드 `client_id` 문자열 그대로입니다. */
  nodeId: string;
  name: string;
  firmware: FirmwareVariant;
  role: NodeRole;
  ingestPath: "mqtt" | "udp" | "collector" | "unknown";
  /**
   * `client_id === "unknown"` 인 노드.
   * 백엔드가 (addr_ip, addr_port) 로 세션 테이블을 역조회해 client_id 를 붙이는데,
   * CONNECT 를 놓쳤거나 UDP 소스 포트가 바뀌면 "unknown" 이 됩니다.
   * 실제 노드가 아니라 "식별 실패한 패킷 묶음"이므로 비교 대상에서 제외해야 합니다.
   */
  isUnidentified?: boolean;
}

/** 환경 센서 1건. 백엔드 `_ENV_FIELDS` + 인메모리 스냅샷 기준. */
export interface TelemetrySample {
  /** Standard MQTT 노드는 백엔드가 항상 0 으로 채웁니다 — 중복 판정에 쓰지 마세요. */
  msgId: number;
  /** 백엔드 `client_id`. */
  nodeId: string;
  /** ISO 8601 + 오프셋. 백엔드는 오프셋 없는 로컬시각을 주므로 mapper 가 보정합니다. */
  timestamp: string;
  temperatureC: number;
  humidityPct: number;
  /**
   * BME680 가스 저항 — **kΩ 단위**.
   * 펌웨어가 `sensor_data.gas_kohm` 을 그대로 보내고(main_gingerbread.cpp),
   * 백엔드 유효범위도 1~10000 kΩ 기준입니다. Ω 로 오해해 1000 으로 나누면 안 됩니다.
   */
  gasResistanceKohm: number;
  /** 백엔드가 매 패킷 재계산하므로 항상 존재합니다. gas 미수신도 false 입니다. */
  gasValid: boolean;
  qos?: 0 | 1 | 2;
  topicId?: number;
  addrIp?: string | null;
  addrPort?: number | null;
  /** 세션 테이블 status 에서 유도. 세션 정보가 없으면 undefined. */
  deviceState?: DeviceState;
  /** 최신 수신 패킷 원문(JSON, 펌웨어 필드명 그대로). */
  rawPayload?: string;

  // ── 백엔드 미지원 (mock 전용) ──────────────────────────────────────────────
  /** 백엔드 미지원 — 펌웨어 JSON 에 기압 필드가 없습니다. */
  pressureHpa?: number;
  /** 백엔드 미지원 — config.json 의 RSSI_THRESHOLD 는 임계값이지 측정값이 아닙니다. */
  rssiDbm?: number;
  /** 백엔드 미지원 — 펌웨어는 `battery`(%) 를 보내지만 게이트웨이가 파싱하지 않고 버립니다. */
  batteryV?: number;
  /** 백엔드 미지원. */
  uptimeS?: number;
}

/**
 * 백엔드 세션 상태 (`app/models/session.py` SessionStatus).
 * `unknown` 은 백엔드에 없는 값으로, 알 수 없는 status 문자열이 왔을 때의 폴백입니다.
 */
export type SessionStatus = "active" | "asleep" | "timed_out" | "unknown";

/**
 * 백엔드 세션 1건.
 * 노드당 세션이 1개라 `client_id` 가 사실상 PK 입니다 — 별도 sessionId 는 없습니다.
 */
export interface SessionSummary {
  /** 백엔드 `client_id`. 조회 키로도 이 값을 씁니다. */
  nodeId: string;
  status: SessionStatus;
  addrIp: string | null;
  addrPort: number | null;
  /** 백엔드는 Unix epoch(float) 로 주고, mapper 가 ISO 로 변환합니다. */
  connectedAt: string;
  lastSeen: string;
  packetCount: number;

  // ── 백엔드 미지원 (mock 전용) ──────────────────────────────────────────────
  /** 백엔드 미지원 — client_id 로 유도할 수는 있습니다. */
  protocol?: "mqtt" | "udp";
  /** 백엔드 미지원 — 세션 단위 QoS 개념이 없습니다. */
  qos?: 0 | 1 | 2;
  note?: string;
}

/** 전력 추정 1건. 백엔드 `_POWER_FIELDS` 기준 (IEEE Access 2024 SW 추정). */
export interface PowerSample {
  timestamp: string;
  nodeId: string;
  qos: 0 | 1 | 2;
  /** PUBLISH~ACK 왕복 시간 (ms). Gingerbread 펌웨어는 항상 0 을 보냅니다. */
  rttMs: number;
  retryCount: number;
  /** 0.0~1.0 */
  sleepModeRatio: number;
  /**
   * 1회 통신 추정 에너지 — **mWh 단위** (mJ 아님).
   * 백엔드 `estimated_energy_mwh`. mJ 가 필요하면 × 3.6.
   */
  energyMwh: number;
  /** 디바이스 누적 패킷 수. Gingerbread 는 펌웨어가 안 보내 항상 0. */
  packetCount: number;
  /** 디바이스 누적 전송 바이트. Gingerbread 는 항상 0. */
  totalBytes: number;

  // ── 백엔드 미지원 (mock 전용) ──────────────────────────────────────────────
  /** 백엔드 미지원 — INA226 폐지 후 SW 추정 경로에서 0.0 하드코딩. */
  voltageV?: number;
  /** 백엔드 미지원 — 0.0 하드코딩. */
  currentMa?: number;
  /** 백엔드 미지원 — energyMwh 에서 역산한 값이라 독립 정보가 아닙니다. */
  powerMw?: number;
  /** 백엔드 미지원 — config.json 의 CURRENT_BATTERY_LEVEL 은 수동 설정값입니다. */
  estimatedBatteryPct?: number;
  /** 백엔드 미지원 — power.csv 에 조인 키가 없습니다. */
  msgId?: number;
  /** 백엔드 미지원 — 프런트에서 자체 판정합니다. */
  isConnectionSpike?: boolean;
}

/**
 * QoS 진단. 백엔드 `GET /api/diagnostics` 의 `qos` 블록 기준 —
 * **게이트웨이 전역 집계이고 노드별로 분리되지 않습니다.**
 */
export interface ProtocolStats {
  /** 요청한 노드. 값 자체는 전역 집계라는 점에 주의. */
  nodeId: string;
  windowLabel: string;
  totalDelivered: number;
  pendingQos2Count: number;
  totalPubackSent: number;
  totalPubrecSent: number;
  totalPubcompSent: number;
  totalQos2Expired: number;
  /** 리스너 수신/오류 카운터. */
  recvCount: number;
  errorCount: number;
  listenerAlive: boolean;
}

/** 프런트에서 히스토리로 직접 계산합니다 — 백엔드에 요약 API 가 없습니다. */
export interface StatsSummary {
  nodeId: string;
  windowKind: "session" | "time";
  windowLabel: string;
  avgTemperatureC: number;
  avgHumidityPct: number;
  avgGasResistanceKohm: number;
  sampleCount: number;
}

/**
 * 게이트웨이 **전역** 설정 (`GET/POST /api/config`).
 * 백엔드에 노드별 설정 API 는 없습니다 — 예전 `NodeConfig` 를 대체합니다.
 */
export interface GatewayConfig {
  rssiThreshold: number;
  packetLossLimit: number;
  /** 단위 kΩ (백엔드 키 이름이 GAS_THRESHOLD_KOHM). */
  gasThresholdKohm: number;
  tempThresholdCelsius: number;
  powerMode: "EXTERNAL_5V" | "BATTERY" | string;
  currentBatteryLevel: number;
}

/**
 * 다운링크 제어. 백엔드는 `POST /api/v1/control` 로 UDP 패킷을 쏘고 즉시 응답할 뿐
 * **명령 이력도 ACK 추적도 하지 않습니다.**
 */
export interface ControlResult {
  status: string;
  msgId: number;
  packetSize: number;
  target: string;
  message: string;
  timestamp: string;
}

/** 백엔드가 실제로 표현할 수 있는 제어는 이 둘뿐입니다. */
export interface ControlDownlink {
  qosLevel: 0 | 1 | 2;
  /** 슬립 간격 (ms). */
  sleepIntervalMs: number;
}

/**
 * 지원하지 않는 동작을 호출했을 때 던집니다.
 * 화면에서 이 에러만 따로 잡아 "백엔드 미지원" 안내로 바꿔 보여주세요.
 */
export class UnsupportedOperationError extends Error {
  constructor(operation: string, detail: string) {
    super(`${operation} — 백엔드 미지원: ${detail}`);
    this.name = "UnsupportedOperationError";
  }
}

/**
 * 프론트엔드가 필요로 하는 모든 읽기/쓰기 동작의 최소 계약.
 * mock ↔ http 구현을 이 인터페이스 하나로 교체합니다.
 */
export interface TelemetrySource {
  listNodes(): Promise<NodeInfo[]>;

  /** 수신 데이터가 없으면 null. (백엔드는 404 대신 0 으로 채운 200 을 주므로 mapper 가 걸러냅니다.) */
  getLatestTelemetry(nodeId: string): Promise<TelemetrySample | null>;
  getTelemetryHistory(nodeId: string, limitSamples: number): Promise<TelemetrySample[]>;
  /** 실시간 스트림 구독. 구독 해제 함수를 반환합니다. */
  subscribeTelemetry(nodeId: string, onSample: (sample: TelemetrySample) => void): () => void;

  listSessions(nodeId?: string): Promise<SessionSummary[]>;
  getSession(nodeId: string): Promise<SessionSummary | null>;

  getPowerHistory(nodeId: string, limitSamples: number): Promise<PowerSample[]>;

  /** 백엔드 미지원 — http 모드에서는 UnsupportedOperationError 를 던집니다. */
  truncateTelemetry(nodeId: string): Promise<{ truncatedAt: string }>;
  /** 텔레메트리 로그를 CSV 로 내보냅니다. http 모드에서는 노드 구분 없이 전체 파일입니다. */
  exportTelemetryCsv(nodeId: string): Promise<Blob>;

  getProtocolStats(nodeId: string): Promise<ProtocolStats>;

  getStatsSummary(nodeId: string): Promise<StatsSummary>;

  getGatewayConfig(): Promise<GatewayConfig>;
  updateGatewayConfig(patch: Partial<GatewayConfig>): Promise<GatewayConfig>;

  /** 다운링크 제어 패킷 전송. 대상 IP/포트는 세션 테이블에서 조회합니다. */
  sendControlDownlink(nodeId: string, downlink: ControlDownlink): Promise<ControlResult>;

  getConnectionState(): ConnectionState;
  onConnectionStateChange(listener: (state: ConnectionState) => void): () => void;
}
