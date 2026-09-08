/**
 * 백엔드 없이 화면 전체를 돌려보기 위한 목업 소스.
 *
 * 타입은 백엔드 실제 스펙(types.ts)을 따르지만, **mock 은 백엔드가 제공하지 않는 필드까지
 * 일부러 채웁니다.** 기압·RSSI·배터리·가동시간 카드가 mock 에서는 값이 보이고
 * http 모드에서는 "데이터 없음(백엔드 미지원)" 으로 바뀌는 것이 의도된 동작입니다.
 */

import type {
  ConnectionState,
  ControlDownlink,
  ControlResult,
  FirmwareVariant,
  GatewayConfig,
  NodeInfo,
  PowerSample,
  ProtocolStats,
  SessionSummary,
  StatsSummary,
  TelemetrySample,
  TelemetrySource,
} from "./types";
import {
  CLIENT_ID_GINGERBREAD,
  CLIENT_ID_MONITOR,
  CLIENT_ID_STANDARD_MQTT,
} from "./mappers";

/** 실제 백엔드와 같은 client_id 를 쓰므로 mock ↔ http 전환 시 노드 식별이 이어집니다. */
const NODES: NodeInfo[] = [
  {
    nodeId: CLIENT_ID_STANDARD_MQTT,
    name: "Standard MQTT",
    firmware: "standard_mqtt",
    role: "baseline",
    ingestPath: "mqtt",
  },
  {
    nodeId: CLIENT_ID_GINGERBREAD,
    name: "Gingerbread",
    firmware: "gingerbread",
    role: "primary",
    ingestPath: "udp",
  },
  {
    nodeId: CLIENT_ID_MONITOR,
    name: "Power Monitor",
    firmware: "monitor",
    role: "primary",
    ingestPath: "udp",
  },
];

function isoNow(offsetMs = 0): string {
  return new Date(Date.now() + offsetMs).toISOString().replace("Z", "+00:00");
}

function seededRandom(seed: number) {
  let s = seed % 2147483647;
  if (s <= 0) s += 2147483646;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

function clamp(v: number, min: number, max: number) {
  return Math.max(min, Math.min(max, v));
}
function round(v: number, digits: number) {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

const FIRMWARE_BY_NODE: Record<string, FirmwareVariant> = {
  [CLIENT_ID_STANDARD_MQTT]: "standard_mqtt",
  [CLIENT_ID_GINGERBREAD]: "gingerbread",
  [CLIENT_ID_MONITOR]: "monitor",
};

/** BME680 가스 저항 정상 범위(kΩ). 백엔드 _GAS_MIN_OHM/_GAS_MAX_OHM 과 같은 단위입니다. */
const GAS_MIN_KOHM = 25;
const GAS_MAX_KOHM = 175;

class NodeSimState {
  msgId = 0;
  temperatureC: number;
  humidityPct: number;
  pressureHpa = 1013 + Math.random() * 6 - 3;
  gasResistanceKohm: number;
  batteryV = 4.05 + Math.random() * 0.1;
  uptimeS = Math.floor(Math.random() * 50_000);
  rand: () => number;

  constructor(seed: number, baseTemp: number, baseGasKohm: number) {
    this.rand = seededRandom(seed);
    this.temperatureC = baseTemp;
    this.humidityPct = 45 + this.rand() * 10;
    this.gasResistanceKohm = baseGasKohm;
  }

  tick(): TelemetrySample {
    this.msgId += 1;
    this.temperatureC += (this.rand() - 0.5) * 0.3;
    this.humidityPct = clamp(this.humidityPct + (this.rand() - 0.5) * 1.2, 30, 80);
    this.pressureHpa += (this.rand() - 0.5) * 0.4;
    // 가스 저항은 VOC 농도가 오를수록 떨어지는 경향을 단순 시뮬레이션
    this.gasResistanceKohm = clamp(this.gasResistanceKohm + (this.rand() - 0.52) * 4, 20, 180);
    this.batteryV = clamp(this.batteryV - 0.00004 + (this.rand() - 0.5) * 0.0005, 3.3, 4.2);
    this.uptimeS += 2;

    const gasResistanceKohm = round(this.gasResistanceKohm, 1);
    return {
      msgId: this.msgId,
      nodeId: "",
      timestamp: isoNow(),
      temperatureC: round(this.temperatureC, 2),
      humidityPct: round(this.humidityPct, 1),
      gasResistanceKohm,
      gasValid: computeGasValid(gasResistanceKohm, this.rand),
      qos: 1,
      // ── 백엔드 미지원 필드 — mock 에서만 채웁니다 ──
      pressureHpa: round(this.pressureHpa, 1),
      rssiDbm: Math.round(-58 - this.rand() * 22),
      batteryV: round(this.batteryV, 3),
      uptimeS: this.uptimeS,
    };
  }
}

/** BME680 가스 저항이 정상 판정 범위를 벗어나는 경우가 드물게 섞이도록 시뮬레이션 */
function computeGasValid(gasResistanceKohm: number, rand: () => number): boolean {
  if (gasResistanceKohm < GAS_MIN_KOHM || gasResistanceKohm > GAS_MAX_KOHM) return false;
  return rand() > 0.03;
}

/** Gingerbread 는 발행 직후 짧게 ACTIVE, 나머지 구간은 ASLEEP 인 duty-cycle 노드 */
function computeDeviceState(nodeId: string, tick: number): "active" | "asleep" | undefined {
  if (FIRMWARE_BY_NODE[nodeId] !== "gingerbread") return undefined;
  return tick % 5 === 0 ? "active" : "asleep";
}

/** 펌웨어가 실제로 보내는 JSON 키 이름을 그대로 흉내 냅니다. */
function buildRawPayload(sample: TelemetrySample): string {
  const firmware = FIRMWARE_BY_NODE[sample.nodeId];
  const payload: Record<string, unknown> = {
    temp: sample.temperatureC,
    hum: sample.humidityPct,
    gas: sample.gasResistanceKohm,
    qos: sample.qos ?? 1,
    rtt: 0.0,
    retry: 0,
    sleep_r: firmware === "gingerbread" ? 0.82 : 0.11,
  };
  if (firmware === "gingerbread") {
    payload.battery = 100;
    payload.nn = 0.42;
  } else {
    payload.pkt = sample.msgId;
    payload.bytes = sample.msgId * 96;
  }
  return JSON.stringify(payload, null, 2);
}

/**
 * 펌웨어별 1회 통신 에너지 프로필 (mWh).
 * Gingerbread(UDP, duty-cycle)가 Standard MQTT(TCP+keepalive) 대비 크게 낮습니다.
 * 1 mWh = 3600 mJ 이므로 예전 mJ 값을 3600 으로 나눈 스케일입니다.
 */
const ENERGY_PROFILE_MWH: Record<FirmwareVariant, { base: number; jitter: number }> = {
  gingerbread: { base: 11 / 3600, jitter: 3 / 3600 },
  standard_mqtt: { base: 38 / 3600, jitter: 8 / 3600 },
  monitor: { base: 24 / 3600, jitter: 6 / 3600 },
  unknown: { base: 20 / 3600, jitter: 5 / 3600 },
};

const simStates = new Map<string, NodeSimState>([
  [CLIENT_ID_STANDARD_MQTT, new NodeSimState(1, 23.4, 95)],
  [CLIENT_ID_GINGERBREAD, new NodeSimState(2, 21.8, 110)],
  [CLIENT_ID_MONITOR, new NodeSimState(3, 24.9, 78)],
]);

function seedFor(nodeId: string): number {
  if (nodeId === CLIENT_ID_STANDARD_MQTT) return 11;
  if (nodeId === CLIENT_ID_GINGERBREAD) return 22;
  return 33;
}

function historyFor(nodeId: string, count: number): TelemetrySample[] {
  const sim = simStates.get(nodeId);
  if (!sim) return [];
  const out: TelemetrySample[] = [];
  const rand = seededRandom(seedFor(nodeId));
  let temp = sim.temperatureC - count * 0.02;
  let gas = sim.gasResistanceKohm - count * 0.03;
  let hum = sim.humidityPct;
  for (let i = 0; i < count; i += 1) {
    temp += (rand() - 0.5) * 0.3;
    hum = clamp(hum + (rand() - 0.5) * 1.1, 30, 80);
    gas = clamp(gas + (rand() - 0.5) * 3.8 + 0.025, 20, 180);
    const gasResistanceKohm = round(gas, 1);
    const msgId = i + 1;
    const sample: TelemetrySample = {
      msgId,
      nodeId,
      timestamp: isoNow(-(count - i) * 2000),
      temperatureC: round(temp, 2),
      humidityPct: round(hum, 1),
      gasResistanceKohm,
      gasValid: computeGasValid(gasResistanceKohm, rand),
      qos: 1,
      deviceState: computeDeviceState(nodeId, msgId),
      // ── 백엔드 미지원 필드 — mock 에서만 채웁니다 ──
      pressureHpa: round(1013 + Math.sin(i / 20) * 2, 1),
      rssiDbm: Math.round(-58 - rand() * 22),
      batteryV: round(4.1 - i * 0.0002, 3),
      uptimeS: i * 2,
    };
    sample.rawPayload = buildRawPayload(sample);
    out.push(sample);
  }
  return out;
}

const SESSIONS: SessionSummary[] = [
  {
    nodeId: CLIENT_ID_STANDARD_MQTT,
    status: "active",
    addrIp: "10.61.35.21",
    addrPort: 1883,
    connectedAt: isoNow(-1000 * 60 * 42),
    lastSeen: isoNow(-1000 * 2),
    packetCount: 1260,
    protocol: "mqtt",
    qos: 1,
  },
  {
    nodeId: CLIENT_ID_GINGERBREAD,
    status: "asleep",
    addrIp: "10.61.35.22",
    addrPort: 5000,
    connectedAt: isoNow(-1000 * 60 * 42),
    lastSeen: isoNow(-1000 * 6),
    packetCount: 1258,
    protocol: "udp",
    qos: 0,
    note: "제안 시스템 — duty-cycle 로 대부분 ASLEEP",
  },
  {
    nodeId: CLIENT_ID_MONITOR,
    status: "timed_out",
    addrIp: "10.61.35.23",
    addrPort: 5001,
    connectedAt: isoNow(-1000 * 60 * 60 * 26),
    lastSeen: isoNow(-1000 * 60 * 60 * 20),
    packetCount: 210,
    protocol: "udp",
    qos: 0,
    note: "게이트웨이가 5001 포트를 수신하지 않아 유실됨",
  },
];

function powerHistoryFor(nodeId: string, count: number): PowerSample[] {
  const rand = seededRandom(seedFor(nodeId) * 10);
  const firmware = FIRMWARE_BY_NODE[nodeId] ?? "unknown";
  const energyProfile = ENERGY_PROFILE_MWH[firmware];
  const out: PowerSample[] = [];
  let batteryPct = 88 - rand() * 10;
  // 초기 몇 개 샘플은 Wi-Fi 연결(스캔/핸드셰이크) 비용이 섞여 에너지가 튀는 구간을 시뮬레이션
  const spikeCount = Math.min(3, count);
  for (let i = 0; i < count; i += 1) {
    const voltage = clamp(4.1 - i * 0.0003 + (rand() - 0.5) * 0.02, 3.3, 4.2);
    const current = 18 + rand() * 14;
    batteryPct = clamp(batteryPct - 0.01 - rand() * 0.01, 0, 100);
    const isConnectionSpike = i < spikeCount;
    const rawEnergy = energyProfile.base + (rand() - 0.5) * energyProfile.jitter * 2;
    const energyMwh = isConnectionSpike
      ? rawEnergy * (4 + rand() * 3)
      : Math.max(rawEnergy, energyProfile.base * 0.4);
    const rttMs = round(12 + rand() * 30, 2);
    out.push({
      timestamp: isoNow(-(count - i) * 4000),
      nodeId,
      qos: firmware === "standard_mqtt" ? 1 : 0,
      rttMs,
      retryCount: rand() > 0.9 ? 1 : 0,
      sleepModeRatio: firmware === "gingerbread" ? round(0.8 + rand() * 0.1, 3) : round(rand() * 0.2, 3),
      energyMwh: round(energyMwh, 8),
      packetCount: i + 1,
      totalBytes: (i + 1) * 96,
      // ── 백엔드 미지원 필드 — mock 에서만 채웁니다 ──
      msgId: i + 1,
      voltageV: round(voltage, 3),
      currentMa: round(current, 1),
      powerMw: round(voltage * current, 1),
      estimatedBatteryPct: round(batteryPct, 1),
      isConnectionSpike,
    });
  }
  return out;
}

function csvEscape(value: string | number | boolean | undefined): string {
  if (value === undefined) return "";
  const s = String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** 백엔드 config.json 초기값과 같은 값으로 시작합니다. */
let gatewayConfig: GatewayConfig = {
  rssiThreshold: -80,
  packetLossLimit: 5,
  gasThresholdKohm: 20,
  tempThresholdCelsius: 45,
  powerMode: "EXTERNAL_5V",
  currentBatteryLevel: 100,
};

export function createMockSource(intervalMs: number): TelemetrySource {
  let connectionState: ConnectionState = "connecting";
  const connectionListeners = new Set<(s: ConnectionState) => void>();
  const subscribers = new Map<string, Set<(s: TelemetrySample) => void>>();
  let downlinkMsgId = 0;

  function setConnectionState(next: ConnectionState) {
    connectionState = next;
    connectionListeners.forEach((l) => l(next));
  }

  // 모의 연결 시퀀스: 진짜 소켓처럼 살짝 지연 후 연결됨을 표시
  setTimeout(() => setConnectionState("connected"), 350);

  setInterval(() => {
    subscribers.forEach((set, nodeId) => {
      if (set.size === 0) return;
      const sim = simStates.get(nodeId);
      if (!sim) return;
      const sample = sim.tick();
      sample.nodeId = nodeId;
      sample.deviceState = computeDeviceState(nodeId, sample.msgId);
      sample.rawPayload = buildRawPayload(sample);
      set.forEach((cb) => cb(sample));
    });
  }, intervalMs);

  return {
    async listNodes() {
      return NODES;
    },

    async getLatestTelemetry(nodeId) {
      const sim = simStates.get(nodeId);
      if (!sim) return null;
      const sample = sim.tick();
      sample.nodeId = nodeId;
      sample.deviceState = computeDeviceState(nodeId, sample.msgId);
      sample.rawPayload = buildRawPayload(sample);
      return sample;
    },

    async getTelemetryHistory(nodeId, limitSamples) {
      return historyFor(nodeId, limitSamples);
    },

    subscribeTelemetry(nodeId, onSample) {
      if (!subscribers.has(nodeId)) subscribers.set(nodeId, new Set());
      const set = subscribers.get(nodeId)!;
      set.add(onSample);
      return () => set.delete(onSample);
    },

    async listSessions(nodeId) {
      return nodeId ? SESSIONS.filter((s) => s.nodeId === nodeId) : SESSIONS;
    },

    async getSession(nodeId) {
      return SESSIONS.find((s) => s.nodeId === nodeId) ?? null;
    },

    async getPowerHistory(nodeId, limitSamples) {
      return powerHistoryFor(nodeId, limitSamples);
    },

    async truncateTelemetry(nodeId) {
      // mock 환경에는 실제 로그 파일이 없어 부작용은 없지만, 지연·응답 형태만 재현합니다.
      // (http 모드에서는 백엔드에 엔드포인트가 없어 UnsupportedOperationError 가 납니다.)
      void nodeId;
      await new Promise((r) => setTimeout(r, 300));
      return { truncatedAt: isoNow() };
    },

    async exportTelemetryCsv(nodeId) {
      const history = historyFor(nodeId, 500);
      // 백엔드 telemetry.csv 와 같은 헤더를 씁니다.
      const header =
        "timestamp,client_id,msg_id,qos,topic_id,addr_ip,addr_port,temp,hum,gas,gas_valid,power,raw_payload\n";
      const rows = history.map((s) =>
        [
          s.timestamp,
          s.nodeId,
          s.msgId,
          s.qos ?? 0,
          1,
          "10.61.35.22",
          5000,
          s.temperatureC,
          s.humidityPct,
          s.gasResistanceKohm,
          s.gasValid ? "True" : "False",
          "",
          s.rawPayload ?? "",
        ]
          .map(csvEscape)
          .join(",")
      );
      const csv = header + rows.join("\n") + "\n";
      return new Blob([csv], { type: "text/csv;charset=utf-8;" });
    },

    async getProtocolStats(nodeId) {
      const rand = seededRandom(nodeId.length * 77);
      const delivered = 1200 + Math.floor(rand() * 400);
      return {
        nodeId,
        windowLabel: "게이트웨이 전역 누적",
        totalDelivered: delivered,
        pendingQos2Count: Math.floor(rand() * 3),
        totalPubackSent: Math.floor(delivered * 0.6),
        totalPubrecSent: Math.floor(delivered * 0.2),
        totalPubcompSent: Math.floor(delivered * 0.2),
        totalQos2Expired: Math.floor(rand() * 4),
        recvCount: delivered + Math.floor(rand() * 40),
        errorCount: Math.floor(rand() * 3),
        listenerAlive: true,
      } satisfies ProtocolStats;
    },

    async getStatsSummary(nodeId) {
      const history = historyFor(nodeId, 200);
      const avg = (arr: number[]) =>
        arr.length === 0 ? 0 : arr.reduce((a, b) => a + b, 0) / arr.length;
      return {
        nodeId,
        windowKind: "time",
        windowLabel: "최근 200개 샘플",
        avgTemperatureC: round(avg(history.map((h) => h.temperatureC)), 2),
        avgHumidityPct: round(avg(history.map((h) => h.humidityPct)), 1),
        avgGasResistanceKohm: round(avg(history.map((h) => h.gasResistanceKohm)), 1),
        sampleCount: history.length,
      } satisfies StatsSummary;
    },

    async getGatewayConfig() {
      return gatewayConfig;
    },

    async updateGatewayConfig(patch) {
      gatewayConfig = { ...gatewayConfig, ...patch };
      await new Promise((r) => setTimeout(r, 250));
      return gatewayConfig;
    },

    async sendControlDownlink(nodeId, downlink: ControlDownlink) {
      const session = SESSIONS.find((s) => s.nodeId === nodeId);
      await new Promise((r) => setTimeout(r, 250));
      downlinkMsgId += 1;
      return {
        status: "ok",
        msgId: downlinkMsgId,
        packetSize: 136,
        target: `${session?.addrIp ?? "10.61.35.22"}:${session?.addrPort ?? 5000}`,
        message: `다운링크 제어 패킷이 전송되었습니다 (qos=${downlink.qosLevel}, sleep=${downlink.sleepIntervalMs}ms).`,
        timestamp: isoNow(),
      } satisfies ControlResult;
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
