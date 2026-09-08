/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_DATA_SOURCE?: "mock" | "http";
  readonly VITE_API_BASE_URL?: string;
  readonly VITE_WS_URL?: string;
  /**
   * 게이트웨이 timestamp 의 타임존 오프셋 (예: "+09:00").
   * 백엔드가 오프셋 없는 로컬시각을 보내기 때문에 필요합니다 (docs/CONTRACT-DIFF.md 4-1절).
   * 비워 두면 브라우저 로컬 시간대로 해석합니다.
   */
  readonly VITE_GATEWAY_TZ_OFFSET?: string;
  readonly VITE_MOCK_INTERVAL_MS?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
