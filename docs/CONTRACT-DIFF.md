# 프런트 계약 vs 백엔드 실제 — 차이 분석

- **프런트**: `over-view-main` (이 저장소) — `src/lib/dataSource/httpSource.ts`, `src/lib/dataSource/types.ts`
- **백엔드**: [Kwak-min/MQTT](https://github.com/Kwak-min/MQTT) `backend/` — commit `7665578` (2026-09-03, "Report MQTT publish RTT in telemetry")
- 조사일: 2026-09-08

---

## 0. 한 줄 요약

**현재 `VITE_DATA_SOURCE=http` 로 바꾸면 화면이 전혀 뜨지 않습니다.** 포트(8000 vs 8080)부터 틀리고,
프런트가 호출하는 12개 엔드포인트 중 **경로가 그대로 맞는 것은 0개**입니다.
필드명은 전부 snake_case이고, 프런트가 기대하는 필드 중 **`pressure` · `rssi` · `battery` · `uptime` ·
`device_state` 는 백엔드/펌웨어 어디에도 존재하지 않습니다.**

가장 치명적인 순서:

| # | 문제 | 영향 |
|---|---|---|
| 1 | `/api/v1/nodes` 없음 → `listNodes()` 404 | 노드 목록이 비어 화면 전체가 렌더 안 됨 |
| 2 | WebSocket 경로 `/ws` vs 실제 `/ws/telemetry`, 포트도 다름 | 실시간 스트림 연결 실패 |
| 3 | WS 메시지가 `{type, data}` 봉투인데 프런트는 봉투째 샘플로 파싱 | 연결돼도 전 필드 `undefined` |
| 4 | env 스냅샷이 **노드별이 아닌 전역 1개** | Gingerbread/Standard 비교 화면이 원리적으로 불가능 |
| 5 | `/api/v1/logs/*` 는 CSV 문자열 그대로 반환 (`"25.30"`, `"True"`) | 차트에 숫자 대신 문자열, `gas_valid` 항상 truthy |

---

## 1. 엔드포인트 경로와 HTTP 메서드

백엔드는 **Flask, `0.0.0.0:8080`** 에서 뜹니다 (`backend/main.py`). 프런트 기본값은 `http://localhost:8000` 이라 포트부터 다릅니다.

| 프런트 가정 (`httpSource.ts`) | 백엔드 실제 | 수정 방법 |
|---|---|---|
| `GET /api/v1/nodes` | **없음.** 노드 목록 API 자체가 존재하지 않음 | 프런트에서 상수로 하드코딩하거나, `GET /api/sessions` 의 `client_id` 목록으로 대체. 아래 5절 참고 |
| `GET /api/v1/nodes/{id}/telemetry/latest` | `GET /api/v1/telemetry/latest` — **노드 파라미터 없음**, 항상 전역 최신 1건 | 경로를 바꾸고, 응답의 `environment` 블록을 꺼내 쓸 것. 노드별 분리는 백엔드 수정 필요 |
| `GET /api/v1/nodes/{id}/telemetry?limit=N` | `GET /api/v1/logs/telemetry?limit=N` (노드 필터 없음)<br>또는 `GET /api/telemetry/env?limit=N&client_id=<id>` (**노드 필터 있음, 이쪽 권장**) | `/api/telemetry/env?limit=&client_id=` 로 교체. 응답이 `{count, data}` 봉투인 점 주의 |
| `GET /api/v1/nodes/{id}/power?limit=N` | `GET /api/v1/logs/power?limit=N` — **노드 필터 없음** | 경로 교체 후 `client_id` 로 프런트에서 필터링 |
| `GET /api/v1/sessions`<br>`GET /api/v1/sessions/{sessionId}` | `GET /api/sessions` (`v1` 없음)<br>`GET /api/sessions/{client_id}` — **session id가 아니라 client_id** | `v1` 제거, 조회 키를 `client_id` 로 변경. 응답은 `{count, sessions:[...]}` 봉투 |
| `POST /api/v1/nodes/{id}/telemetry/truncate` | **없음** | 백엔드에 신규 구현하거나 UI에서 기능 제거 |
| `GET /api/v1/nodes/{id}/telemetry/export.csv` | `GET /api/v1/logs/export?type=telemetry\|power` | 쿼리 방식으로 교체. 노드별 분리 불가(파일 통째로 내려옴) |
| `GET /api/v1/nodes/{id}/protocol-stats` | **없음.** 유사한 것은 `GET /api/diagnostics` 의 `qos` 블록 (전역, 노드별 아님) | `/api/diagnostics` 로 대체하고 `ProtocolStats` 타입을 실제 QoS 진단 필드에 맞춰 재정의 |
| `GET /api/v1/stats/summary?node_id=` | **없음** | 백엔드 신규 구현하거나, 프런트에서 히스토리로 평균 계산 |
| `GET /api/v1/nodes/{id}/config`<br>`PATCH /api/v1/nodes/{id}/config` | `GET /api/config`<br>`POST /api/config` (**PATCH 아님**)<br>`POST /api/config/reload` | 메서드를 POST로, 경로를 전역 `/api/config` 로. **노드별 설정이 아니라 게이트웨이 전역 설정**이라 의미가 다름 |
| `GET /api/v1/nodes/{id}/control` (명령 이력) | **없음** | 이력 조회 UI 제거 또는 백엔드 신규 구현 |
| `POST /api/v1/nodes/{id}/control`<br>body: `{kind, payload}` | `POST /api/v1/control`<br>body: `{device_ip, device_port, qos_level, sleep_interval}` — **전부 필수** | 경로에서 `/nodes/{id}` 제거, body 스키마 전면 교체. `kind` 개념이 없으므로 `set_report_interval` → `sleep_interval`, QoS 변경 → `qos_level` 로 매핑. `reboot` / `recalibrate_gas_baseline` / `toggle_relay` 는 **대응 없음** |
| `WS {wsUrl}?node_id={id}`<br>(기본 `ws://localhost:8000/ws`) | `WS /ws/telemetry` — 포트 8080, **`node_id` 쿼리는 완전히 무시됨** | 3절 참고 |
| — | `GET /api/health`, `GET /api/telemetry/latest/env`, `GET /api/telemetry/latest/power?node=`, `GET /api/telemetry/stream` (SSE), `GET /api/sessions/stats` (프런트가 안 쓰는 실존 API) | `/api/health` 는 연결 상태 배지에, `/api/telemetry/latest/env` 는 숫자 타입이 보존되므로 `/api/v1/logs/*` 보다 우선 사용 권장 |

> **`.env` 수정 필수**: `VITE_API_BASE_URL=http://<게이트웨이IP>:8080`, `VITE_WS_URL=ws://<게이트웨이IP>:8080/ws/telemetry`

---

## 2. JSON 필드명 — snake_case, camelCase 아님

백엔드는 **어디에서도 camelCase를 만들지 않습니다.** 프런트 `types.ts` 의 모든 필드명은 변환이 필요합니다.
(단, 전력 스냅샷의 `current_mA` / `voltage_V` / `power_mW` 는 순수 snake_case가 아닌 혼합 표기라 별도 주의)

### 2-1. 환경 텔레메트리 — 실제 응답 필드 전체 목록

출처: `telemetry_service.py` `_ENV_FIELDS` / `_DEFAULT_ENV_SNAPSHOT`, `logs/telemetry.csv` 헤더

```
timestamp, client_id, msg_id, qos, topic_id, addr_ip, addr_port,
temp, hum, gas, gas_valid, power, raw_payload
```
`+ packet_count` (인메모리 스냅샷 `/api/telemetry/latest/env` 에만 있고 CSV 행에는 없음)

| 프런트 가정 (`TelemetrySample`) | 백엔드 실제 | 수정 방법 |
|---|---|---|
| `nodeId: string` | `client_id: string` | 리네임. 5절의 식별자 값 주의 |
| `msgId: number` | `msg_id: number` | 리네임. **Standard MQTT 노드는 항상 `0` 하드코딩** (`standard_mqtt_listener.py:88`) — 중복 판정에 쓰면 안 됨 |
| `timestamp: string` | `timestamp: string` | 이름은 같으나 포맷이 다름 → 4절 |
| `temperatureC: number` | `temp` | 리네임 |
| `humidityPct: number` | `hum` | 리네임 |
| `gasResistanceOhm: number` (Ω 가정, 화면에서 ÷1000) | `gas` — **펌웨어가 kΩ 로 보냄** (`main_gingerbread.cpp:1087` `sensor_data.gas_kohm`). 백엔드 유효범위도 `1.0 ~ 10000.0` kΩ 기준 (`_GAS_MIN_OHM`/`_GAS_MAX_OHM`, 이름만 Ohm) | `gasResistanceKohm` 으로 바꾸고 **÷1000 제거**. 지금 그대로 두면 화면 값이 1000배 작게 표시됨 |
| `rssiDbm: number` | **없음.** `config.json` 의 `RSSI_THRESHOLD` 만 존재(임계값이지 측정값 아님) | 필드 삭제하거나 optional 처리 후 백엔드/펌웨어에 추가 요청 |
| `batteryV: number` | **없음.** Gingerbread 페이로드에 `battery` (%, V 아님)가 있으나 `_extract_sensor_fields()` 가 temp/hum/gas/power만 파싱해 **버려짐** | 백엔드 `_extract_sensor_fields` 에 `battery` 추가 요청. 단위는 V가 아니라 % |
| `uptimeS: number` | **없음** | 필드 삭제 또는 백엔드 추가 요청 |
| `gasValid?: boolean` | `gas_valid: boolean` — **항상 존재** (optional 아님). 매 패킷마다 재계산, `gas` 없으면 `false` | 리네임 후 필수 필드로 변경. "센서 이상"과 "gas 미수신"이 둘 다 `false` 라 구분 불가한 점 주의 |
| `deviceState?: "active" \| "asleep"` | **텔레메트리에 없음.** 세션 테이블의 `status: "ACTIVE" \| "ASLEEP" \| "TIMED_OUT"` 이 유일 (`session.py`) | `GET /api/sessions` 를 조인해서 유도. 값이 대문자이고 `TIMED_OUT` 이 추가로 존재 |
| `rawPayload?: string` | `raw_payload: string \| null` | 리네임 |
| — | `qos`, `topic_id`, `addr_ip`, `addr_port`, `power`, `packet_count` (프런트 타입에 없는 실존 필드) | `qos` 는 프로토콜 화면에, `packet_count` 는 "데이터 수신 여부" 판정에 활용 (4절) |
| `pressureHpa: number` | **없음.** 펌웨어 JSON에 기압 필드 자체가 없음 | BME680은 기압을 지원하지만 펌웨어가 안 보냄 — 필드 삭제 또는 펌웨어 수정 요청 |

### 2-2. 전력 — 실제 응답 필드 전체 목록

CSV / `GET /api/v1/logs/power` (`_POWER_FIELDS`, `logs/power.csv` 헤더):
```
timestamp, client_id, qos, rtt_ms, retry_count,
sleep_mode_ratio, estimated_energy_mwh, packet_count, total_bytes
```

인메모리 스냅샷 `GET /api/telemetry/latest/power` (client_id 별 dict):
```
timestamp, addr_ip, addr_port, current_mA, voltage_V, power_mW,
sample_count, estimated_energy_mwh, rtt_ms, retry_count, sleep_mode_ratio
```

| 프런트 가정 (`PowerSample`) | 백엔드 실제 | 수정 방법 |
|---|---|---|
| `nodeId` | `client_id` | 리네임 |
| `voltageV: number` | `voltage_V` — **SW 추정 경로에서 항상 `0.0` 하드코딩** (`telemetry_service.py:378`) | 표시 제거. INA226 하드웨어 폐지로 실측 불가 |
| `currentMa: number` | `current_mA` — **항상 `0.0` 하드코딩** | 표시 제거 |
| `powerMw: number` | `power_mW` — 역산값 `estimated_energy_mwh × 3_600_000 / max(1, rtt_ms)` | 리네임하되 "추정 순시전력"으로 라벨 변경 |
| `energyMj?: number` (mJ) | `estimated_energy_mwh` — **단위 mWh** (mJ 아님) | `energyMwh` 로 리네임. 굳이 mJ가 필요하면 `× 3.6` |
| `estimatedBatteryPct: number` | **없음.** `config.json` 의 `CURRENT_BATTERY_LEVEL` 은 수동 설정값 | 필드 삭제 |
| `msgId?: number` | **없음.** power.csv에 조인 키 없음 | 텔레메트리↔전력 조인은 `timestamp`(초 단위) + `client_id` 로만 가능 — 같은 초에 2건이면 모호 |
| `isConnectionSpike?: boolean` | **없음** | 프런트에서 자체 판정하거나 스파이크 필터 토글 제거 |
| — | `qos`, `rtt_ms`, `retry_count`, `sleep_mode_ratio`, `packet_count`, `total_bytes` (프런트에 없는 실존 필드) | **README가 정의한 핵심 평가지표들** — `PowerSample` 에 추가 권장 |

> `sleep_mode_ratio`, `packet_count`, `total_bytes` 는 Gingerbread 펌웨어가 `sleep_r` 만 보내고
> `pkt`/`bytes` 는 안 보내므로 Gingerbread 행에서는 항상 `0` 입니다 (Standard MQTT는 셋 다 보냄).

### 2-3. 세션

`GET /api/sessions` → `{count, sessions: [...]}`, 각 항목:
```
client_id, addr_ip, addr_port, status, connected_at, last_seen, packet_count
```

| 프런트 가정 (`SessionSummary`) | 백엔드 실제 | 수정 방법 |
|---|---|---|
| `sessionId` | **없음** — `client_id` 가 사실상 PK (노드당 세션 1개) | `client_id` 로 대체 |
| `protocol`, `qos`, `sampleCount`, `droppedCount`, `note` | **전부 없음** | `protocol` 은 `client_id` 로 유도, `sampleCount` → `packet_count`, 나머지는 삭제 |
| `status: "running"\|"completed"\|"error"\|"aborted"` | `status: "ACTIVE"\|"ASLEEP"\|"TIMED_OUT"` (대문자) | 값 매핑 전면 교체 |
| `startedAt`, `endedAt` | `connected_at`, `last_seen` — **Unix epoch float** (ISO 문자열 아님) | 리네임 + `new Date(v * 1000)` 변환. `endedAt` 개념 없음 |

### 2-4. 설정 / 제어 — 구조 자체가 다름

| 프런트 가정 (`NodeConfig`) | 백엔드 실제 (`GET /api/config` → `{status, config, timestamp}`) | 수정 방법 |
|---|---|---|
| 노드별 설정 (`nodeId` 포함) | **게이트웨이 전역 설정 1벌**, 3개 섹션으로 중첩 | 노드별 UI를 전역 설정 UI로 재설계 |
| `reportIntervalS`, `gasBaselineOhm`, `tempWarnC`, `humidityWarnPct`, `mqttTopic`, `qos` | `NETWORK.RSSI_THRESHOLD`, `NETWORK.PACKET_LOSS_LIMIT`, `ENVIRONMENT.GAS_THRESHOLD_KOHM`, `ENVIRONMENT.TEMP_THRESHOLD_CELSIUS`, `POWER_MANAGEMENT.POWER_MODE`, `POWER_MANAGEMENT.CURRENT_BATTERY_LEVEL` | 대응되는 것은 `tempWarnC`→`TEMP_THRESHOLD_CELSIUS`, `gasBaselineOhm`→`GAS_THRESHOLD_KOHM`(**단위 kΩ**) 둘뿐. 나머지는 신규/삭제. POST는 플랫·중첩 JSON 둘 다 허용됨 |

`ControlCommand` (`commandId` / `kind` / `payload` / `issuedAt` / `ackStatus` / `ackAt`)는 **대응 개념이 전혀 없습니다.**
백엔드는 UDP 다운링크를 쏘고 즉시 응답할 뿐 ACK 추적을 하지 않습니다 → `ackStatus` 는 항상 낙관적 처리하거나 UI에서 제거.

### 2-5. `/api/v1/logs/*` 의 타입 문제 (별도 주의)

`_read_csv_tail()` 이 `csv.DictReader` 결과를 그대로 반환합니다 → **모든 값이 문자열**입니다.

| 프런트 가정 | 백엔드 실제 | 수정 방법 |
|---|---|---|
| `temp: number` → `25.3` | `"temp": "25.30"` (문자열) | `Number()` 변환 필수. 안 하면 차트가 문자열 정렬됨 |
| `gasValid: boolean` → `true/false` | `"gas_valid": "True"` / `"False"` — **Python bool의 문자열** | `v === "True"` 로 파싱. `Boolean("False")` 는 `true` 라 그냥 쓰면 항상 유효 판정 |
| `null` 값 | CSV 왕복 후 `""` (빈 문자열) | `"" → null` 변환 필요 |

→ **권장**: 최신 1건은 타입이 보존되는 `GET /api/telemetry/latest/env` 를 쓰고,
`/api/v1/logs/*` 를 쓸 때는 전용 파서를 거칠 것.

---

## 3. WebSocket — 존재함, 단 경로·봉투·필터가 전부 다름

**존재합니다.** `flask-sock` 기반 `WS /ws/telemetry` (`websocket_controller.py`).
`flask-sock` 미설치 시 경고만 남기고 조용히 비활성화되므로, 안 될 때 `pip install flask-sock` 부터 확인하세요.

| 프런트 가정 | 백엔드 실제 | 수정 방법 |
|---|---|---|
| `ws://localhost:8000/ws?node_id={id}` | `ws://<host>:8080/ws/telemetry` | `.env` 의 `VITE_WS_URL` 을 `ws://<host>:8080/ws/telemetry` 로 |
| `?node_id=` 로 노드별 구독 | **쿼리 파라미터를 읽지 않음.** 핸들러가 `telemetry_svc.subscribe_env()` 로 **전역 큐**를 구독 → 모든 노드 데이터가 섞여 옴 | 프런트에서 `data.client_id` 로 필터링. 소켓을 노드당 1개씩 열 이유도 없으니 **단일 소켓 + 팬아웃** 구조로 변경 |
| 메시지 = `TelemetrySample` 그 자체 | **봉투 구조** `{type, ...}`, 3종:<br>• `{"type":"connected", "message", "timestamp"}`<br>• `{"type":"telemetry", "data":{...env row..., "estimated_energy_mwh":n}}`<br>• `{"type":"heartbeat", "timestamp"}` (30초 간격) | `onmessage` 에서 `msg.type === "telemetry"` 일 때만 `msg.data` 를 샘플로 사용. **현재 코드는 봉투를 통째로 캐스팅해 전 필드가 `undefined`** |
| — | `data` 에는 env row 전 필드 + `estimated_energy_mwh` 가 병합됨. 단 이 에너지는 **해당 패킷 값이 아니라 "아무 노드나 첫 번째로 발견된" 최신 스냅샷** (`_extract_estimated_energy()`) | 노드 비교 화면에서는 이 값을 쓰지 말고 `/api/v1/logs/power` 를 `client_id` 로 필터해 쓸 것 |
| 대안 없음 | `GET /api/telemetry/stream` (SSE) 도 동일 데이터 제공, **봉투 없이 row 그대로** | WS가 막히면 EventSource로 폴백 가능 |

---

## 4. timestamp 형식과 null 처리

### 4-1. timestamp

| 프런트 가정 | 백엔드 실제 | 수정 방법 |
|---|---|---|
| ISO 8601 + 오프셋<br>`2026-09-03T10:41:07+09:00` | `time.strftime("%Y-%m-%dT%H:%M:%S")`<br>→ `"2026-09-08T16:41:07"`<br>**오프셋 없음 · 밀리초 없음 · 게이트웨이 로컬시각** | 프런트에서 `+09:00` 을 붙여 파싱하거나, 백엔드를 `datetime.now().astimezone().isoformat()` 으로 교체(권장) |
| — | **초 해상도**. 1초 안에 여러 패킷이 오면 timestamp가 동일 | 차트 x축 키로 쓰면 점이 겹침 → `msg_id` 병용 |
| 세션도 같은 문자열 형식일 것 | 세션의 `connected_at` / `last_seen` 은 **Unix epoch float** (`1716000000.0`) | 한 API 안에서 표현이 두 가지 → 세션은 `new Date(v*1000)` 로 별도 처리 |
| — | `server_time` / `/api/health` 의 `time` 도 동일한 오프셋 없는 로컬시각 | 클라이언트-서버 시계 차 보정 불가 |

### 4-2. null 처리

| 프런트 가정 | 백엔드 실제 | 수정 방법 |
|---|---|---|
| 데이터 없으면 `404` → `getLatestTelemetry()` 가 `null` 반환 | **404를 절대 반환하지 않음.** 첫 패킷 전에도 200 + 기본 스냅샷 | `res.status === 404` 분기는 죽은 코드. **`packet_count === 0` 또는 `timestamp === null` 로 "미수신" 판정**해야 함 |
| 값이 없으면 `null` | 센서 필드 기본값이 **`0.0`** (`temp/hum/gas/power`), `gas_valid` 는 `false` | **0.0 과 "미수신"이 구분 불가.** 위의 `packet_count` 가드 없이 렌더하면 0°C / 0% 를 실측처럼 표시함 |
| 메타 필드도 0 | 메타는 정직하게 `null` (`timestamp`, `client_id`, `msg_id`, `qos`, `topic_id`, `addr_ip`, `addr_port`, `raw_payload`) | 메타 필드로 미수신 판정하는 게 안전 |
| 부분 패킷이면 해당 필드가 null | **carry-forward**: 새 패킷에 `temp` 가 없으면 **직전 값을 유지** (`telemetry_service.py:262~`). 단 `gas_valid` 만은 매번 재계산 | 최신 스냅샷의 값은 "이번 패킷 값"이 아닐 수 있음. 정확한 패킷별 값이 필요하면 `/api/telemetry/env` 이력을 쓸 것 |
| — | CSV 왕복 시 `None → ""`, `True → "True"` | 2-5절 참고 |
| — | 파싱 실패("N/A" 등)는 경고 로그 후 `None`, 패킷 자체는 버리지 않음 | 부분 결측 행이 정상 응답에 섞여 들어옴 |

---

## 5. gingerbread / standard_mqtt 노드 식별

**결론: 유일한 식별자는 `client_id` 문자열이며, `firmware` / `role` / `node_id` / `ingestPath` 필드는 백엔드에 존재하지 않습니다.**

| 프런트 가정 (`NodeInfo`) | 백엔드 실제 | 수정 방법 |
|---|---|---|
| `nodeId: string` (임의 ID) | `client_id` 문자열이 곧 식별자 | 아래 실제 값으로 하드코딩 |
| `firmware: "standard_mqtt" \| "monitor" \| "gingerbread"` | **필드 없음.** 값으로 구분:<br>• `"ESP32-Gingerbread"` — `main_gingerbread.cpp:105` `BOARD1_CLIENT_ID`, CONNECT 패킷(16바이트)으로 전달<br>• `"ESP32-Standard-MQTT"` — **`main.py` 의 `on_standard_telemetry` 에 하드코딩**. 페이로드가 아니라 *토픽 `environmental/standard` 로 들어왔다*는 사실로 결정<br>• `"ESP32-Power-Monitor"` — `main_monitor.cpp:97`, **UDP 5001 로 전송하는데 백엔드는 5001을 안 듣음 → 절대 나타나지 않음** | `client_id → firmware` 매핑 테이블을 프런트 상수로 유지. `"monitor"` 는 현재 도달 불가하므로 목록에서 제외 |
| `role: "primary" \| "baseline"` | **없음.** README 상 Gingerbread=제안 시스템, Standard MQTT=베이스라인 | 프런트 상수로 |
| `ingestPath: "mqtt"\|"udp"\|"collector"` | **없음.** 실제로는 Gingerbread=UDP 5000, Standard=MQTT 브로커 `10.61.35.14:1883` 토픽 `environmental/standard` 구독 | 프런트 상수로 |
| `name: string` | **없음** | 프런트 상수로 |

### 식별이 실패하는 경우 (중요)

- Gingerbread의 `client_id` 는 텔레메트리 패킷에 실려오지 않습니다. 백엔드가 **`(addr_ip, addr_port)` 로 세션 테이블을 역조회**해서 붙입니다 (`main.py` `on_env_deliver`).
  → **CONNECT를 놓쳤거나 UDP 소스 포트가 바뀌면 `client_id = "unknown"`** 이 되어 노드 매칭이 끊깁니다. 프런트는 `"unknown"` 을 별도 처리해야 합니다.
- 게이트웨이가 브로커에 접속할 때 쓰는 ID는 `"gingerbread-gateway-standard"` 입니다. 노드 식별자와 혼동하지 마세요.

### 가장 큰 구조적 문제

`TelemetryService.telemetry_data` 는 **전역 딕셔너리 1개**입니다 (`"최신 환경 데이터 단일 전역 스냅샷"`).
두 노드의 패킷이 같은 스냅샷을 덮어씁니다.

- `/api/v1/telemetry/latest` 와 `/api/telemetry/latest/env` 의 `environment` 는 **마지막에 도착한 노드 것 하나뿐** — 노드별 최신값을 동시에 볼 수 없습니다.
- 전력만 `power_data[client_id]` 로 노드별 분리가 되어 있습니다.
- **Gingerbread vs Standard 비교 화면(이 프로젝트의 존재 이유)은 이 상태로는 성립하지 않습니다.**

→ 수정 방법 (택 1):
1. **백엔드 수정(권장)**: `telemetry_data` 를 `power_data` 처럼 `{client_id: snapshot}` 으로 변경.
2. **프런트 우회**: 최신값 대신 `GET /api/telemetry/env?limit=N&client_id=<id>` 를 노드별로 폴링해 마지막 행을 최신값으로 사용.

---

## 6. 덤 — 백엔드 쪽 실제 버그 (프런트 수정으로는 못 고침)

| 위치 | 증상 | 비고 |
|---|---|---|
| `telemetry_service.get_recent_power(node=)` | `r.get("node")` 로 필터하는데 **power.csv에 `node` 컬럼이 없음** (`client_id` 로 교체됨) → `?node=` 주면 **항상 빈 배열** | `GET /api/telemetry/power?node=A` 가 무조건 빈 응답 |
| `telemetry_service.get_latest_power(node=)` | `node.upper()` 로 조회하는데 실제 키는 `"ESP32-Gingerbread"` → **영원히 매칭 실패**, 0으로 채워진 기본값 반환 | `?node=` 파라미터는 사실상 사용 불가 |
| `telemetry_service.py` 로그/주석 | `gas` 를 Ω로 취급해 `gas/1000` 을 kΩ로 출력하는데 입력이 이미 kΩ | 로그 값이 1000배 작게 찍힘 |
| `websocket_controller._extract_estimated_energy` | 노드 구분 없이 **첫 번째로 발견된** `estimated_energy_mwh` 를 반환 | WS의 에너지 값은 다른 노드 것일 수 있음 |
| `main_gingerbread.cpp:1082` | 페이로드의 `"rtt":0.0, "retry":0` 이 **항상 0으로 하드코딩** (실제 RTT는 ACK 후 계산되나 페이로드엔 미반영) | Gingerbread의 `estimated_energy_mwh` 는 RTT=0 기반이라 사실상 0 → **전력 비교 그래프가 무의미**. Standard MQTT만 실측 RTT를 보냄 |

---

## 7. 권장 수정 순서

1. **`.env`**: 포트 `8080`, WS 경로 `/ws/telemetry` 로 수정 — 이것만으로 연결은 됨
2. **`httpSource.ts`**: 1절 표대로 경로/메서드 교체, 응답 봉투(`{count,data}`, `{status,config}`) 언랩
3. **매퍼 레이어 신설** (`src/lib/dataSource/mappers.ts`): snake_case → camelCase, 문자열→숫자, `"True"`→boolean, epoch→ISO 변환을 한곳에 격리
4. **WS 핸들러**: 봉투 파싱 + `client_id` 필터링 + 단일 소켓 구조로 변경
5. **`types.ts` 정리**: 존재하지 않는 필드(`pressureHpa` · `rssiDbm` · `batteryV` · `uptimeS` · `estimatedBatteryPct` · `isConnectionSpike`) 제거 또는 optional 화, `gasResistanceOhm` → `gasResistanceKohm`, `energyMj` → `energyMwh`
6. **미수신 판정**: 404 분기 대신 `packet_count === 0 || timestamp === null` 가드 추가 (0.0을 실측으로 표시하는 것 방지)
7. **백엔드 협의 항목**: ① `telemetry_data` 노드별 분리 ② timestamp에 타임존 오프셋 ③ `/api/v1/logs/*` 숫자 타입 보존 ④ Gingerbread 페이로드의 실제 RTT ⑤ `battery` 필드 파싱 ⑥ `/nodes` 목록 API
