/**
 * 백엔드(Kwak-min/MQTT `backend/`) 실제 스펙에 맞춘 HTTP/WebSocket 구현.
 *
 * 경로·메서드·필드명의 근거는 docs/CONTRACT-DIFF.md 1절에 정리돼 있습니다.
 * 응답 파싱/단위 변환은 전부 `mappers.ts` 에 격리했습니다 — 이 파일은 "무엇을 부르는가"만 다룹니다.
 *
 * 백엔드 구조상 불가피한 우회
 * ──────────────────────────
 * - 노드 목록 API 가 없어 `client_id` 상수 + 세션/텔레메트리 스캔으로 구성합니다.
 * - 환경 스냅샷이 **노드별이 아닌 전역 1개**라(`telemetry_data`) 최신값을 쓸 수 없습니다.
 *   대신 `/api/telemetry/env?limit=N&client_id=<id>` 를 노드별로 조회해 마지막 행을 최신값으로 씁니다.
 * - WebSocket 이 `node_id` 쿼리를 무시하고 전역 큐를 흘려보내므로,
 *   **소켓 하나만 열고** 프런트에서 `client_id` 로 팬아웃합니다.
 */

import type {
  ConnectionState,
  ControlDownlink,
  ControlResult,
  GatewayConfig,
  NodeInfo,
  ProtocolStats,
  SessionSummary,
  StatsSummary,
  TelemetrySample,
  TelemetrySource,
} from "./types";
import { UnsupportedOperationError } from "./types";
import {
  CLIENT_ID_UNKNOWN,
  KNOWN_NODE_IDS,
  type RawRow,
  deviceStateFromSession,
  gatewayConfigToBody,
  hasTelemetryData,
  mapControlResult,
  mapDiagnostics,
  mapGatewayConfig,
  mapPowerRow,
  mapSessionRow,
  mapTelemetryRow,
  nodeInfoFromClientId,
} from "./mappers";

interface HttpSourceOptions {
  baseUrl: string;
  wsUrl: string;
}

/**
 * 백엔드 `get_recent_env()` 는 `limit * 2` 행만 읽고 나서 client_id 로 거릅니다.
 * 두 노드가 번갈아 들어오므로 limit=1 로 요청하면 다른 노드 행만 잡혀 빈 배열이 오기 쉽습니다.
 * 최신 1건을 구할 때는 넉넉히 읽고 마지막 행을 씁니다.
 */
const LATEST_LOOKBACK = 50;

/** 백엔드 limit 상한 (`_parse_limit` 의 max_val). */
const MAX_LIMIT = 1000;

/** WebSocket 재연결 백오프 (ms). */
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 15000;

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    throw new Error(`API 오류 ${res.status}: ${res.statusText}`);
  }
  return (await res.json()) as T;
}

export function createHttpSource(opts: HttpSourceOptions): TelemetrySource {
  const { baseUrl, wsUrl } = opts;

  let connectionState: ConnectionState = "connecting";
  const connectionListeners = new Set<(s: ConnectionState) => void>();

  /** nodeId(client_id) → 구독자 집합. 소켓은 전체에서 하나만 씁니다. */
  const subscribers = new Map<string, Set<(s: TelemetrySample) => void>>();
  let socket: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectAttempt = 0;
  /** 의도적으로 닫은 경우 재연결하지 않기 위한 플래그. */
  let closingIntentionally = false;

  /** nodeId → 세션 상태 캐시. 텔레메트리에 없는 deviceState 를 채우는 데 씁니다. */
  const sessionStatusCache = new Map<string, SessionSummary["status"]>();

  function setConnectionState(next: ConnectionState) {
    if (connectionState === next) return;
    connectionState = next;
    connectionListeners.forEach((l) => l(next));
  }

  function totalSubscribers(): number {
    let n = 0;
    subscribers.forEach((set) => {
      n += set.size;
    });
    return n;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // WebSocket — 단일 소켓 + client_id 팬아웃
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * 백엔드 메시지는 `{type, ...}` 봉투입니다 (docs/CONTRACT-DIFF.md 3절):
   *   {"type":"connected", ...} / {"type":"telemetry", "data":{...}} / {"type":"heartbeat", ...}
   * 봉투를 통째로 샘플로 캐스팅하면 전 필드가 undefined 가 됩니다.
   */
  function handleMessage(raw: string) {
    let envelope: unknown;
    try {
      envelope = JSON.parse(raw);
    } catch {
      // 파싱 실패 패킷은 무시 — 집계는 /api/diagnostics 에서 확인합니다.
      return;
    }
    if (!envelope || typeof envelope !== "object") return;

    const { type, data } = envelope as { type?: unknown; data?: unknown };
    if (type !== "telemetry") return; // connected / heartbeat 는 상태 신호일 뿐입니다.
    if (!data || typeof data !== "object") return;

    const sample = mapTelemetryRow(data as RawRow);
    sample.deviceState = deviceStateFromSession(sessionStatusCache.get(sample.nodeId));

    // 백엔드가 전역 큐를 흘려보내므로 여기서 노드별로 갈라 줍니다.
    subscribers.get(sample.nodeId)?.forEach((cb) => cb(sample));
  }

  function scheduleReconnect() {
    if (closingIntentionally || reconnectTimer !== null) return;
    if (totalSubscribers() === 0) return;

    const delay = Math.min(RECONNECT_BASE_MS * 2 ** reconnectAttempt, RECONNECT_MAX_MS);
    reconnectAttempt += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      ensureSocket();
    }, delay);
  }

  function ensureSocket() {
    if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
      return;
    }
    closingIntentionally = false;
    setConnectionState("connecting");

    // 경로는 /ws/telemetry 고정. node_id 쿼리는 백엔드가 읽지 않으므로 붙이지 않습니다.
    const next = new WebSocket(wsUrl);
    socket = next;

    next.onopen = () => {
      reconnectAttempt = 0;
      setConnectionState("connected");
    };
    next.onmessage = (event) => handleMessage(String(event.data));
    next.onerror = () => setConnectionState("error");
    next.onclose = () => {
      if (socket === next) socket = null;
      if (closingIntentionally) {
        setConnectionState("disconnected");
        return;
      }
      setConnectionState("disconnected");
      scheduleReconnect();
    };
  }

  function closeSocketIfIdle() {
    if (totalSubscribers() > 0) return;
    closingIntentionally = true;
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    socket?.close();
    socket = null;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // 내부 조회 헬퍼
  // ───────────────────────────────────────────────────────────────────────────

  /** `GET /api/telemetry/env` — 노드 필터를 지원하는 유일한 텔레메트리 이력 API. */
  async function fetchEnvRows(nodeId: string, limit: number): Promise<RawRow[]> {
    const capped = Math.min(Math.max(limit, 1), MAX_LIMIT);
    const url =
      `${baseUrl}/api/telemetry/env?limit=${capped}` +
      `&client_id=${encodeURIComponent(nodeId)}`;
    const payload = await json<{ count: number; data: RawRow[] }>(await fetch(url));
    return Array.isArray(payload?.data) ? payload.data : [];
  }

  /** 세션 상태 캐시를 갱신하고 매핑된 세션 목록을 돌려줍니다. */
  async function fetchSessions(): Promise<SessionSummary[]> {
    const payload = await json<{ count: number; sessions: RawRow[] }>(
      await fetch(`${baseUrl}/api/sessions`)
    );
    const rows = Array.isArray(payload?.sessions) ? payload.sessions : [];
    const sessions = rows.map(mapSessionRow);
    sessionStatusCache.clear();
    sessions.forEach((s) => sessionStatusCache.set(s.nodeId, s.status));
    return sessions;
  }

  /** 텔레메트리 샘플에 세션 기반 deviceState 를 채웁니다. */
  function withDeviceState(sample: TelemetrySample): TelemetrySample {
    sample.deviceState = deviceStateFromSession(sessionStatusCache.get(sample.nodeId));
    return sample;
  }

  return {
    /**
     * 노드 목록. 백엔드에 `/api/v1/nodes` 가 없어 직접 구성합니다.
     *   1) 비교 대상 두 노드를 씨앗으로 깔고
     *   2) 세션 테이블에 나타난 client_id 를 더하고
     *   3) 세션이 없는 "unknown" 은 최근 텔레메트리에서 찾아 별도 노드로 표시합니다.
     */
    async listNodes() {
      const ordered: string[] = [...KNOWN_NODE_IDS];
      const seen = new Set(ordered);

      try {
        const sessions = await fetchSessions();
        sessions.forEach((s) => {
          if (!seen.has(s.nodeId)) {
            seen.add(s.nodeId);
            ordered.push(s.nodeId);
          }
        });
      } catch {
        // 세션 API 실패는 치명적이지 않습니다 — 알려진 두 노드만으로도 화면은 뜹니다.
      }

      // client_id 역조회에 실패한 패킷("unknown")은 세션에 안 잡히므로 따로 확인합니다.
      if (!seen.has(CLIENT_ID_UNKNOWN)) {
        try {
          const rows = await fetchEnvRows(CLIENT_ID_UNKNOWN, LATEST_LOOKBACK);
          if (rows.length > 0) {
            seen.add(CLIENT_ID_UNKNOWN);
            ordered.push(CLIENT_ID_UNKNOWN);
          }
        } catch {
          // 무시 — unknown 노드가 없다고 보고 진행합니다.
        }
      }

      return ordered.map(nodeInfoFromClientId) satisfies NodeInfo[];
    },

    /**
     * 최신 1건. 전역 스냅샷(`/api/v1/telemetry/latest`)은 마지막에 도착한 노드 것 하나뿐이라
     * 쓸 수 없습니다 — 노드별 이력을 조회해 마지막 행을 씁니다.
     *
     * 데이터가 없으면 null 을 돌려줍니다. 백엔드는 404 대신 0 으로 채운 200 을 주기 때문에
     * `hasTelemetryData()` 로 걸러 0°C / 0% 를 실측처럼 표시하지 않게 합니다.
     */
    async getLatestTelemetry(nodeId) {
      const rows = await fetchEnvRows(nodeId, LATEST_LOOKBACK);
      const last = rows[rows.length - 1];
      if (!hasTelemetryData(last)) return null;
      return withDeviceState(mapTelemetryRow(last));
    },

    async getTelemetryHistory(nodeId, limitSamples) {
      // 백엔드가 limit*2 행만 읽고 필터하므로 넉넉히 요청한 뒤 프런트에서 자릅니다.
      const rows = await fetchEnvRows(nodeId, Math.min(limitSamples * 2, MAX_LIMIT));
      return rows
        .filter(hasTelemetryData)
        .slice(-limitSamples)
        .map((row) => withDeviceState(mapTelemetryRow(row)));
    },

    subscribeTelemetry(nodeId, onSample) {
      if (!subscribers.has(nodeId)) subscribers.set(nodeId, new Set());
      subscribers.get(nodeId)!.add(onSample);
      ensureSocket();

      return () => {
        const set = subscribers.get(nodeId);
        set?.delete(onSample);
        if (set && set.size === 0) subscribers.delete(nodeId);
        closeSocketIfIdle();
      };
    },

    async listSessions(nodeId) {
      const sessions = await fetchSessions();
      return nodeId ? sessions.filter((s) => s.nodeId === nodeId) : sessions;
    },

    /** 조회 키가 sessionId 가 아니라 client_id 입니다. */
    async getSession(nodeId) {
      const res = await fetch(`${baseUrl}/api/sessions/${encodeURIComponent(nodeId)}`);
      if (res.status === 404) return null;
      return mapSessionRow(await json<RawRow>(res));
    },

    /** 전력 로그는 노드 필터가 없어 전체를 받아 프런트에서 거릅니다. */
    async getPowerHistory(nodeId, limitSamples) {
      const capped = Math.min(Math.max(limitSamples * 2, 1), MAX_LIMIT);
      const payload = await json<{ count: number; data: RawRow[] }>(
        await fetch(`${baseUrl}/api/v1/logs/power?limit=${capped}`)
      );
      const rows = Array.isArray(payload?.data) ? payload.data : [];
      return rows
        .map(mapPowerRow)
        .filter((s) => s.nodeId === nodeId)
        .slice(-limitSamples);
    },

    /** 백엔드에 로그 초기화 엔드포인트가 없습니다. */
    async truncateTelemetry(nodeId) {
      void nodeId;
      throw new UnsupportedOperationError(
        "로그 초기화",
        "게이트웨이에 telemetry truncate 엔드포인트가 없습니다 (docs/CONTRACT-DIFF.md 1절)"
      );
    },

    /**
     * CSV 내보내기. 백엔드는 파일을 통째로 내려주므로 **노드별 분리가 되지 않습니다** —
     * 두 노드의 행이 모두 섞인 telemetry.csv 가 받아집니다.
     */
    async exportTelemetryCsv(nodeId) {
      void nodeId;
      const res = await fetch(`${baseUrl}/api/v1/logs/export?type=telemetry`);
      if (!res.ok) {
        throw new Error(`API 오류 ${res.status}: ${res.statusText}`);
      }
      return res.blob();
    },

    /** 노드별 통계가 없어 게이트웨이 전역 진단으로 대체합니다. */
    async getProtocolStats(nodeId) {
      const payload = await json<RawRow>(await fetch(`${baseUrl}/api/diagnostics`));
      return mapDiagnostics(payload, nodeId) satisfies ProtocolStats;
    },

    /** 요약 API 가 없어 이력으로 직접 계산합니다. */
    async getStatsSummary(nodeId) {
      const rows = await fetchEnvRows(nodeId, 200);
      const samples = rows.filter(hasTelemetryData).map(mapTelemetryRow);
      const avg = (values: number[]) =>
        values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;

      return {
        nodeId,
        windowKind: "time",
        windowLabel: `최근 ${samples.length}개 샘플`,
        avgTemperatureC: avg(samples.map((s) => s.temperatureC)),
        avgHumidityPct: avg(samples.map((s) => s.humidityPct)),
        avgGasResistanceKohm: avg(samples.map((s) => s.gasResistanceKohm)),
        sampleCount: samples.length,
      } satisfies StatsSummary;
    },

    async getGatewayConfig() {
      const payload = await json<RawRow>(await fetch(`${baseUrl}/api/config`));
      // 응답 봉투: {status, config, timestamp}
      const config = (payload.config ?? {}) as RawRow;
      return mapGatewayConfig(config) satisfies GatewayConfig;
    },

    /** PATCH 가 아니라 POST 입니다. 백엔드가 플랫 JSON 을 받아줍니다. */
    async updateGatewayConfig(patch) {
      const res = await fetch(`${baseUrl}/api/config`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(gatewayConfigToBody(patch)),
      });
      const payload = await json<RawRow>(res);
      const config = (payload.config ?? {}) as RawRow;
      return mapGatewayConfig(config);
    },

    /**
     * 다운링크 제어. 백엔드는 대상 IP/포트를 요청 본문으로 요구하므로
     * 세션 테이블에서 해당 노드의 addr_ip / addr_port 를 찾아 채웁니다.
     * (Gingerbread 펌웨어는 로컬 소켓을 UDP_SERVER_PORT 에 바인딩하므로
     *  세션의 소스 포트가 곧 다운링크 수신 포트입니다.)
     */
    async sendControlDownlink(nodeId, downlink: ControlDownlink) {
      const session = await this.getSession(nodeId);
      if (!session || !session.addrIp || session.addrPort === null) {
        throw new UnsupportedOperationError(
          "제어 명령 전송",
          `'${nodeId}' 의 주소를 세션 테이블에서 찾을 수 없습니다 — 노드가 CONNECT 하기 전이거나 식별에 실패했습니다`
        );
      }

      const res = await fetch(`${baseUrl}/api/v1/control`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          device_ip: session.addrIp,
          device_port: session.addrPort,
          qos_level: downlink.qosLevel,
          sleep_interval: downlink.sleepIntervalMs,
        }),
      });
      return mapControlResult(await json<RawRow>(res)) satisfies ControlResult;
    },

    getConnectionState() {
      return connectionState;
    },

    onConnectionStateChange(listener) {
      connectionListeners.add(listener);
      return () => connectionListeners.delete(listener);
    },
  };
}
