import { useEffect, useMemo, useState } from "react";
import { useNodes } from "@/hooks/useNodes";
import { useLiveTelemetry } from "@/hooks/useLiveTelemetry";
import { usePowerHistory } from "@/hooks/usePowerHistory";
import { useTelemetrySource, useConnectionState } from "@/hooks/useTelemetrySource";
import { StatTile } from "@/components/ui/StatTile";
import { DeviceStateBadge } from "@/components/ui/DeviceStateBadge";
import { GasValidTag } from "@/components/ui/GasValidTag";
import { UnsupportedValue } from "@/components/ui/UnsupportedValue";
import { LineChart } from "@/components/charts/LineChart";
import { EnergyBarCompare } from "@/components/dashboard/EnergyBarCompare";
import { SpikeFilterToggle } from "@/components/dashboard/SpikeFilterToggle";
import { PayloadViewer } from "@/components/dashboard/PayloadViewer";
import { ExperimentControlPanel } from "@/components/dashboard/ExperimentControlPanel";
import { getDataSourceMode } from "@/lib/dataSource";
import { markConnectionSpikes } from "@/lib/spike";
import {
  FIRMWARE_COLOR,
  MJ_PER_MWH,
  SESSION_STATUS_COLOR,
  SESSION_STATUS_LABEL,
  formatEnergyPerMessage,
  formatGasResistance,
  formatHumidity,
  formatPressure,
  formatRelativeTime,
  formatRssi,
  formatTemperature,
  formatUptime,
  formatVoltage,
} from "@/lib/format";
import type {
  DeviceState,
  NodeInfo,
  PowerSample,
  SessionStatus,
  SessionSummary,
  TelemetrySample,
} from "@/lib/dataSource/types";
import { UnsupportedOperationError } from "@/lib/dataSource/types";

const CONNECTION_LABEL: Record<string, string> = {
  connected: "연결됨",
  connecting: "연결 중",
  disconnected: "연결 끊김",
  error: "오류",
};

/** 두 보드 동시 적용용 전송 주기. 백엔드는 ms 단위 sleep_interval 을 받습니다. */
const DOWNLINK_QOS = 1;

/**
 * 실험 상태는 세션 상태에서 유도합니다.
 * 백엔드에는 running/completed 같은 실험 단위 개념이 없고 노드 생사만 있습니다
 * (docs/CONTRACT-DIFF.md 2-3절).
 */
function deriveExperimentStatus(sessions: SessionSummary[]): SessionStatus | null {
  if (sessions.length === 0) return null;
  if (sessions.some((s) => s.status === "active")) return "active";
  if (sessions.some((s) => s.status === "asleep")) return "asleep";
  // 알 수 없는 status 만 남았다면 "응답 없음"으로 단정하지 않습니다.
  if (sessions.some((s) => s.status === "timed_out")) return "timed_out";
  return "unknown";
}

/** 회당 에너지 요약. 백엔드 단위가 mWh 라 표시용 mJ 는 여기서 환산합니다. */
function summarizeEnergy(samples: PowerSample[], excludeSpikes: boolean) {
  const filtered = excludeSpikes ? samples.filter((s) => !s.isConnectionSpike) : samples;
  if (filtered.length === 0) return { avgMwh: null as number | null, totalMwh: 0 };
  const totalMwh = filtered.reduce((sum, s) => sum + s.energyMwh, 0);
  return { avgMwh: totalMwh / filtered.length, totalMwh };
}

export function OverviewPage() {
  const { nodes, loading } = useNodes();
  const source = useTelemetrySource();
  const connectionState = useConnectionState();
  const mode = getDataSourceMode();
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [spikeFilter, setSpikeFilter] = useState(true);
  const [reportIntervalS, setReportIntervalS] = useState<number | null>(null);
  const [applyingInterval, setApplyingInterval] = useState(false);
  const [truncating, setTruncating] = useState(false);
  const [exportingNodeId, setExportingNodeId] = useState<string | null>(null);
  const [selectedPayloadNode, setSelectedPayloadNode] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ kind: "info" | "error"; text: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    source
      .listSessions()
      .then((list) => {
        if (!cancelled) setSessions(list);
      })
      .catch(() => {
        if (!cancelled) setSessions([]);
      });
    return () => {
      cancelled = true;
    };
  }, [source]);

  const gingerbread = nodes.find((n) => n.firmware === "gingerbread") ?? null;
  const standardMqtt = nodes.find((n) => n.firmware === "standard_mqtt") ?? null;
  /** client_id 역조회에 실패한 패킷 묶음. 실제 노드가 아니므로 비교에서 제외하고 경고만 띄웁니다. */
  const unidentified = nodes.filter((n) => n.isUnidentified);

  const gbTelemetry = useLiveTelemetry(gingerbread?.nodeId ?? null, 40);
  const mqttTelemetry = useLiveTelemetry(standardMqtt?.nodeId ?? null, 40);

  const gbPowerRaw = usePowerHistory(gingerbread?.nodeId ?? null, 60, 3000);
  const mqttPowerRaw = usePowerHistory(standardMqtt?.nodeId ?? null, 60, 3000);

  // 백엔드에 스파이크 플래그가 없어 프런트에서 판정해 채웁니다.
  const gbSamples = useMemo(() => markConnectionSpikes(gbPowerRaw.samples), [gbPowerRaw.samples]);
  const mqttSamples = useMemo(
    () => markConnectionSpikes(mqttPowerRaw.samples),
    [mqttPowerRaw.samples]
  );

  const gbEnergy = useMemo(() => summarizeEnergy(gbSamples, spikeFilter), [gbSamples, spikeFilter]);
  const mqttEnergy = useMemo(
    () => summarizeEnergy(mqttSamples, spikeFilter),
    [mqttSamples, spikeFilter]
  );

  const savingsPct =
    gbEnergy.avgMwh !== null && mqttEnergy.avgMwh !== null && mqttEnergy.avgMwh > 0
      ? ((mqttEnergy.avgMwh - gbEnergy.avgMwh) / mqttEnergy.avgMwh) * 100
      : null;

  const relevantSessions = sessions.filter(
    (s) => s.nodeId === gingerbread?.nodeId || s.nodeId === standardMqtt?.nodeId
  );
  const experimentStatus = deriveExperimentStatus(relevantSessions);

  const gbFiltered = spikeFilter ? gbSamples.filter((s) => !s.isConnectionSpike) : gbSamples;
  const mqttFiltered = spikeFilter ? mqttSamples.filter((s) => !s.isConnectionSpike) : mqttSamples;

  const payloadOptions = [
    gingerbread && {
      nodeId: gingerbread.nodeId,
      label: gingerbread.name,
      color: FIRMWARE_COLOR.gingerbread,
      payload: gbTelemetry.latest?.rawPayload ?? null,
    },
    standardMqtt && {
      nodeId: standardMqtt.nodeId,
      label: standardMqtt.name,
      color: FIRMWARE_COLOR.standard_mqtt,
      payload: mqttTelemetry.latest?.rawPayload ?? null,
    },
  ].filter((o): o is { nodeId: string; label: string; color: string; payload: string | null } =>
    Boolean(o)
  );

  const activePayloadNodeId = selectedPayloadNode ?? payloadOptions[0]?.nodeId ?? null;

  /**
   * 전송 주기 변경. 백엔드의 다운링크는 `{qos_level, sleep_interval(ms)}` 만 표현할 수 있어
   * "보고 주기"를 슬립 간격으로 매핑합니다 (docs/CONTRACT-DIFF.md 1절).
   */
  async function handleSetInterval(seconds: number) {
    const targets = [gingerbread, standardMqtt].filter((n): n is NodeInfo => n !== null);
    if (targets.length === 0) return;
    setApplyingInterval(true);
    setNotice(null);
    try {
      await Promise.all(
        targets.map((n) =>
          source.sendControlDownlink(n.nodeId, {
            qosLevel: DOWNLINK_QOS,
            sleepIntervalMs: seconds * 1000,
          })
        )
      );
      setReportIntervalS(seconds);
      setNotice({ kind: "info", text: `전송 주기를 ${seconds}초로 적용했습니다.` });
    } catch (err) {
      setNotice({
        kind: "error",
        text:
          err instanceof UnsupportedOperationError
            ? err.message
            : `전송 주기 적용에 실패했습니다: ${(err as Error).message}`,
      });
    } finally {
      setApplyingInterval(false);
    }
  }

  async function handleTruncate() {
    const targets = [gingerbread, standardMqtt].filter((n): n is NodeInfo => n !== null);
    if (targets.length === 0) return;
    if (!window.confirm("로그를 초기화할까요? 헤더만 남고 데이터 본문이 모두 삭제됩니다.")) return;
    setTruncating(true);
    setNotice(null);
    try {
      await Promise.all(targets.map((n) => source.truncateTelemetry(n.nodeId)));
      setNotice({ kind: "info", text: "로그를 초기화했습니다." });
    } catch (err) {
      setNotice({
        kind: "error",
        text:
          err instanceof UnsupportedOperationError
            ? err.message
            : `로그 초기화에 실패했습니다: ${(err as Error).message}`,
      });
    } finally {
      setTruncating(false);
    }
  }

  async function handleExportCsv(nodeId: string) {
    setExportingNodeId(nodeId);
    setNotice(null);
    try {
      const blob = await source.exportTelemetryCsv(nodeId);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = mode === "http" ? "telemetry.csv" : `${nodeId}-telemetry.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setNotice({ kind: "error", text: `CSV 내보내기에 실패했습니다: ${(err as Error).message}` });
    } finally {
      setExportingNodeId(null);
    }
  }

  if (loading) {
    return <div className="empty-state">노드 정보를 불러오는 중…</div>;
  }

  if (!gingerbread || !standardMqtt) {
    return (
      <div className="empty-state">
        Gingerbread 와 Standard MQTT 노드가 모두 등록되어야 비교 대시보드를 표시할 수 있습니다.
      </div>
    );
  }

  const gbSession = sessions.find((s) => s.nodeId === gingerbread.nodeId);
  const mqttSession = sessions.find((s) => s.nodeId === standardMqtt.nodeId);

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>실험 개요</h1>
          <p className="page-sub">
            {gingerbread.name} vs {standardMqtt.name} · 통신 1회당 에너지 소모 비교
          </p>
        </div>
      </div>

      {unidentified.length > 0 && (
        <NoticeBar
          kind="error"
          text={`식별되지 않은 노드(client_id="unknown") 가 감지되었습니다. 게이트웨이가 CONNECT 를 놓쳤거나 UDP 소스 포트가 바뀌어 세션 역조회에 실패한 패킷으로, 어느 보드의 것인지 알 수 없어 비교에서 제외했습니다.`}
        />
      )}

      {notice && <NoticeBar kind={notice.kind} text={notice.text} />}

      {/* KPI: 실험 상태 → 에너지 절감 순으로 시선이 이동하도록 상태 타일을 가장 먼저 배치 */}
      <div className="grid-stats">
        <StatTile
          label="실험 / 연결 상태"
          value={experimentStatus ? SESSION_STATUS_LABEL[experimentStatus] : "대기 중"}
          accent={experimentStatus ? SESSION_STATUS_COLOR[experimentStatus] : undefined}
          sub={`연결 ${CONNECTION_LABEL[connectionState] ?? connectionState}`}
        />
        <StatTile
          label="Gingerbread 1회 통신 에너지"
          value={gbEnergy.avgMwh !== null ? (gbEnergy.avgMwh * MJ_PER_MWH).toFixed(1) : "-"}
          unit="mJ"
          accent="var(--signal-violet)"
          sub={gingerbread.name}
        />
        <StatTile
          label="Standard MQTT 1회 통신 에너지"
          value={mqttEnergy.avgMwh !== null ? (mqttEnergy.avgMwh * MJ_PER_MWH).toFixed(1) : "-"}
          unit="mJ"
          accent="var(--signal-teal)"
          sub={standardMqtt.name}
        />
        <StatTile
          label="Gingerbread 상대 에너지 절감률"
          value={savingsPct !== null ? savingsPct.toFixed(0) : "-"}
          unit="%"
          accent={savingsPct !== null && savingsPct >= 0 ? "var(--signal-green)" : "var(--signal-red)"}
          sub="Standard MQTT 대비"
        />
      </div>

      {/* 두 보드 비교 차트: 회당 에너지 추이 + 누적 에너지 */}
      <div className="panel">
        <div className="panel-header">
          <h2>회당 통신 에너지 추이</h2>
          <SpikeFilterToggle checked={spikeFilter} onChange={setSpikeFilter} />
        </div>
        <div className="panel-body">
          <LineChart
            series={[
              {
                label: `${standardMqtt.name} (mJ)`,
                color: FIRMWARE_COLOR.standard_mqtt,
                values: mqttFiltered.map((s) => s.energyMwh),
              },
              {
                label: `${gingerbread.name} (mJ)`,
                color: FIRMWARE_COLOR.gingerbread,
                values: gbFiltered.map((s) => s.energyMwh),
              },
            ]}
            formatValue={formatEnergyPerMessage}
          />
          {mode === "http" && (
            <p className="page-sub" style={{ marginTop: 10, fontSize: 11 }}>
              Gingerbread 펌웨어는 페이로드의 <code>rtt</code> 를 항상 0 으로 보내고, 게이트웨이의
              에너지 추정식이 RTT 기반이라 이 값이 0 에 가깝게 나올 수 있습니다
              (docs/CONTRACT-DIFF.md 6절).
            </p>
          )}
        </div>
      </div>

      <div className="panel" style={{ marginTop: 16 }}>
        <div className="panel-header">
          <h2>누적 통신 에너지</h2>
        </div>
        <div className="panel-body">
          <EnergyBarCompare
            bars={[
              {
                label: gingerbread.name,
                color: FIRMWARE_COLOR.gingerbread,
                valueMwh: gbEnergy.totalMwh,
              },
              {
                label: standardMqtt.name,
                color: FIRMWARE_COLOR.standard_mqtt,
                valueMwh: mqttEnergy.totalMwh,
              },
            ]}
          />
        </div>
      </div>

      {/* 센서 및 단말 상태 */}
      <div className="grid-two" style={{ marginTop: 16 }}>
        <div className="panel">
          <div className="panel-header">
            <h2>센서 · 단말 상태</h2>
          </div>
          <div className="panel-body">
            <div style={{ display: "flex", flexDirection: "column", gap: 14, marginBottom: 16 }}>
              <BoardStatusRow
                name={gingerbread.name}
                color={FIRMWARE_COLOR.gingerbread}
                sample={gbTelemetry.latest}
                sessionStatus={gbSession?.status}
              />
              <BoardStatusRow
                name={standardMqtt.name}
                color={FIRMWARE_COLOR.standard_mqtt}
                sample={mqttTelemetry.latest}
                sessionStatus={mqttSession?.status}
              />
            </div>
            <LineChart
              series={[
                {
                  label: `${standardMqtt.name} 가스저항 (kΩ)`,
                  color: FIRMWARE_COLOR.standard_mqtt,
                  values: mqttTelemetry.samples.map((s) => s.gasResistanceKohm),
                },
                {
                  label: `${gingerbread.name} 가스저항 (kΩ)`,
                  color: FIRMWARE_COLOR.gingerbread,
                  values: gbTelemetry.samples.map((s) => s.gasResistanceKohm),
                },
              ]}
              formatValue={formatGasResistance}
              height={140}
            />
          </div>
        </div>

        <div className="panel">
          <div className="panel-header">
            <h2>최신 페이로드</h2>
          </div>
          <div className="panel-body">
            <PayloadViewer
              options={payloadOptions}
              selectedNodeId={activePayloadNodeId}
              onSelect={setSelectedPayloadNode}
            />
          </div>
        </div>
      </div>

      {/* 실험 제어 */}
      <div className="panel" style={{ marginTop: 16 }}>
        <div className="panel-header">
          <h2>실험 제어</h2>
        </div>
        <div className="panel-body">
          <ExperimentControlPanel
            activeIntervalS={reportIntervalS}
            applyingInterval={applyingInterval}
            onSetInterval={handleSetInterval}
            onTruncate={handleTruncate}
            truncating={truncating}
            truncateUnsupported={mode === "http"}
            onExportCsv={handleExportCsv}
            exportingNodeId={exportingNodeId}
            statusLabel={experimentStatus ? SESSION_STATUS_LABEL[experimentStatus] : "대기 중"}
            statusColor={
              experimentStatus ? SESSION_STATUS_COLOR[experimentStatus] : "var(--text-tertiary)"
            }
            exportTargets={
              // http 모드의 백엔드는 CSV 를 통째로 내려주므로 노드별 버튼이 의미가 없습니다.
              mode === "http"
                ? [{ nodeId: gingerbread.nodeId, label: "전체 텔레메트리" }]
                : [
                    { nodeId: gingerbread.nodeId, label: gingerbread.name },
                    { nodeId: standardMqtt.nodeId, label: standardMqtt.name },
                  ]
            }
            exportNote={
              mode === "http"
                ? "게이트웨이는 telemetry.csv 를 통째로 내려줍니다 — 노드별로 분리되지 않습니다."
                : null
            }
          />
        </div>
      </div>
    </div>
  );
}

function NoticeBar({ kind, text }: { kind: "info" | "error"; text: string }) {
  const color = kind === "error" ? "var(--signal-red)" : "var(--signal-teal)";
  return (
    <div
      style={{
        marginBottom: 14,
        padding: "10px 12px",
        borderRadius: "var(--radius-sm)",
        background: "var(--bg-inset)",
        border: `1px solid ${color}`,
        color: "var(--text-secondary)",
        fontSize: 12,
        lineHeight: 1.6,
      }}
    >
      <span className="dot" style={{ background: color, marginRight: 8 }} />
      {text}
    </div>
  );
}

function BoardStatusRow({
  name,
  color,
  sample,
  sessionStatus,
}: {
  name: string;
  color: string;
  sample: TelemetrySample | null;
  sessionStatus?: SessionStatus;
}) {
  // 세션 상태가 있으면 그쪽을 우선합니다 — 텔레메트리에는 device_state 가 없습니다.
  const deviceState: DeviceState | undefined =
    sample?.deviceState ??
    (sessionStatus === "active" ? "active" : sessionStatus === "asleep" ? "asleep" : undefined);

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        flexWrap: "wrap",
        gap: 10,
        padding: "10px 12px",
        borderRadius: "var(--radius-sm)",
        background: "var(--bg-inset)",
        border: "1px solid var(--border-hair)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 140 }}>
        <span className="dot" style={{ background: color }} />
        <span style={{ fontSize: 13 }}>{name}</span>
      </div>

      {sample === null ? (
        <span style={{ fontSize: 12, color: "var(--text-tertiary)" }}>
          아직 수신된 데이터가 없습니다.
        </span>
      ) : (
        <div style={{ display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
          <MiniValue label="온도" value={formatTemperature(sample.temperatureC)} />
          <MiniValue label="습도" value={formatHumidity(sample.humidityPct)} />
          <MiniValue label="가스" value={formatGasResistance(sample.gasResistanceKohm)} />

          {/* 아래 4개는 백엔드/펌웨어가 제공하지 않습니다 — mock 에서만 값이 보입니다. */}
          <MiniValue
            label="기압"
            value={sample.pressureHpa !== undefined ? formatPressure(sample.pressureHpa) : null}
            unsupportedReason="펌웨어 JSON 에 기압 필드가 없습니다"
          />
          <MiniValue
            label="RSSI"
            value={sample.rssiDbm !== undefined ? formatRssi(sample.rssiDbm) : null}
            unsupportedReason="config.json 의 RSSI_THRESHOLD 는 임계값이지 측정값이 아닙니다"
          />
          <MiniValue
            label="배터리"
            value={sample.batteryV !== undefined ? formatVoltage(sample.batteryV) : null}
            unsupportedReason="펌웨어가 보내는 battery(%) 를 게이트웨이가 파싱하지 않고 버립니다"
          />
          <MiniValue
            label="가동시간"
            value={sample.uptimeS !== undefined ? formatUptime(sample.uptimeS) : null}
            unsupportedReason="게이트웨이가 uptime 을 기록하지 않습니다"
          />

          <DeviceStateBadge state={deviceState} />
          <GasValidTag valid={sample.gasValid} />
          <span className="mono" style={{ fontSize: 11, color: "var(--text-tertiary)" }}>
            {formatRelativeTime(sample.timestamp)}
          </span>
        </div>
      )}
    </div>
  );
}

function MiniValue({
  label,
  value,
  unsupportedReason,
}: {
  label: string;
  value: string | null;
  unsupportedReason?: string;
}) {
  return (
    <div>
      <div style={{ fontSize: 10, color: "var(--text-tertiary)" }}>{label}</div>
      {value === null ? (
        <UnsupportedValue reason={unsupportedReason} />
      ) : (
        <div className="mono" style={{ fontSize: 13 }}>
          {value}
        </div>
      )}
    </div>
  );
}
