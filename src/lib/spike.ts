import type { PowerSample } from "./dataSource/types";

/**
 * 초기 Wi-Fi 연결(스캔·핸드셰이크) 비용이 섞여 에너지가 튀는 구간을 표시합니다.
 *
 * 백엔드에는 `is_connection_spike` 같은 플래그가 없으므로(docs/CONTRACT-DIFF.md 2-2절)
 * 프런트에서 판정합니다. 평균은 스파이크 자신에게 끌려가므로 **중앙값 기준**으로 봅니다.
 *
 * mock 은 이미 `isConnectionSpike` 를 채워 보내므로 그 값을 그대로 존중하고,
 * 값이 없는 http 모드에서만 계산합니다.
 */

/** 중앙값의 이 배수를 넘으면 연결 스파이크로 봅니다. */
const SPIKE_MEDIAN_RATIO = 3;

/** 표본이 이보다 적으면 중앙값이 의미가 없어 판정하지 않습니다. */
const MIN_SAMPLES = 5;

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * `isConnectionSpike` 가 비어 있는 샘플에만 판정 결과를 채워 돌려줍니다.
 * 이미 값이 있는 샘플(mock)은 건드리지 않습니다.
 */
export function markConnectionSpikes(samples: PowerSample[]): PowerSample[] {
  if (samples.length === 0) return samples;
  if (samples.every((s) => s.isConnectionSpike !== undefined)) return samples;

  const energies = samples.map((s) => s.energyMwh).filter((v) => v > 0);
  if (energies.length < MIN_SAMPLES) return samples;

  const threshold = median(energies) * SPIKE_MEDIAN_RATIO;
  if (threshold <= 0) return samples;

  return samples.map((s) =>
    s.isConnectionSpike === undefined
      ? { ...s, isConnectionSpike: s.energyMwh > threshold }
      : s
  );
}
