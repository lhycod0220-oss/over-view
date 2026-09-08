import { useEffect, useRef, useState } from "react";
import { useTelemetrySource } from "./useTelemetrySource";
import type { TelemetrySample } from "@/lib/dataSource/types";

/** 중복 판정 시 거슬러 볼 최근 샘플 수. 폴링 배치와 WS 푸시가 겹치는 구간만 덮으면 충분합니다. */
const DEDUP_WINDOW = 5;

/**
 * 폴링과 WebSocket 이 같은 행을 중복 append 하지 않도록 만드는 서명.
 *
 * `msgId` 를 단독 키로 쓰면 안 됩니다 — **Standard MQTT 노드는 백엔드가 msg_id 를 항상 0 으로
 * 하드코딩**하고(`standard_mqtt_listener.py`), 백엔드 timestamp 는 **초 해상도**라
 * (timestamp, msgId) 조합만으로는 같은 초에 도착한 서로 다른 샘플을 구분할 수 없습니다.
 * 그래서 센서 실측값까지 서명에 포함합니다. msgId 는 표시/참고용으로만 남깁니다.
 * (docs/CONTRACT-DIFF.md 2-1절·4-1절)
 */
function sampleSignature(s: TelemetrySample): string {
  return [
    s.nodeId,
    s.timestamp,
    s.msgId,
    s.temperatureC,
    s.humidityPct,
    s.gasResistanceKohm,
    s.gasValid,
  ].join("|");
}

/**
 * 노드별 텔레메트리 이력 + 실시간 갱신.
 *
 * 백엔드의 최신값 스냅샷(`/api/v1/telemetry/latest`)은 **노드별이 아니라 전역 1개**라
 * 두 노드 비교에 쓸 수 없습니다 (docs/CONTRACT-DIFF.md 5절). 그래서 노드별 필터를 지원하는
 * `/api/telemetry/env?limit=N&client_id=<id>` 를 **주기적으로 폴링**해 마지막 행을 최신값으로 씁니다.
 *
 * WebSocket 구독은 그 위에 얹는 즉시 갱신 경로입니다. 게이트웨이에 flask-sock 이 설치돼 있지
 * 않으면 WS 가 조용히 비활성화되는데, 폴링이 있으므로 그 경우에도 화면은 계속 갱신됩니다.
 */
export function useLiveTelemetry(nodeId: string | null, historyLength = 60, pollMs = 4000) {
  const source = useTelemetrySource();
  const [samples, setSamples] = useState<TelemetrySample[]>([]);
  const [loading, setLoading] = useState(true);
  const maxLen = useRef(historyLength);
  maxLen.current = historyLength;

  useEffect(() => {
    if (!nodeId) {
      setSamples([]);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);

    // ── 폴링: 노드별 이력을 통째로 다시 받아 최신 상태의 기준으로 삼습니다 ──
    function load() {
      source
        .getTelemetryHistory(nodeId as string, historyLength)
        .then((history) => {
          if (cancelled) return;
          setSamples(history);
          setLoading(false);
        })
        .catch(() => {
          // 폴링 실패는 화면을 비우지 않고 직전 값을 유지합니다 — 다음 주기에 재시도합니다.
          if (!cancelled) setLoading(false);
        });
    }

    load();
    const pollId = setInterval(load, pollMs);

    // ── WebSocket: 폴링 주기 사이를 메우는 즉시 갱신 경로 ──
    const unsubscribe = source.subscribeTelemetry(nodeId, (sample) => {
      setSamples((prev) => {
        // 폴링이 이미 가져온 행이 WS 로 또 오면 중복 append 하지 않습니다.
        if (prev.slice(-DEDUP_WINDOW).some((s) => sampleSignature(s) === sampleSignature(sample))) {
          return prev;
        }
        const next = [...prev, sample];
        if (next.length > maxLen.current) next.shift();
        return next;
      });
    });

    return () => {
      cancelled = true;
      clearInterval(pollId);
      unsubscribe();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeId, source, historyLength, pollMs]);

  return { samples, latest: samples[samples.length - 1] ?? null, loading };
}
