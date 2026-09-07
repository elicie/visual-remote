import { useEffect, useState } from "preact/hooks";
import type { ComparisonState } from "@visual-remote/protocol";
import { fetchComparisonImage, type BridgeRequestOptions } from "./bridge.js";

const STATUS_LABELS: Record<ComparisonState["status"], string> = {
  preparing: "기준 준비 중",
  capturing: "현재 탭 캡처 중",
  comparing: "비교 중",
  correcting: "차이 수정 중",
  passed: "비교 기준 통과",
  unmatched: "비교 기준 미달",
  blocked: "비교 차단됨",
  canceled: "비교 취소됨",
};
function ComparisonImage({
  id,
  label,
  token,
  options,
}: {
  id: string;
  label: string;
  token: string;
  options: BridgeRequestOptions;
}) {
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let objectUrl = "";
    setUrl("");
    setError("");
    void fetchComparisonImage(token, id, controller.signal, options)
      .then((blob) => {
        if (controller.signal.aborted) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted)
          setError(
            reason instanceof Error
              ? reason.message
              : "이미지를 불러오지 못했습니다.",
          );
      });
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [id, token, options.authMode, options.mode, retry]);
  return (
    <figure class="comparison-image">
      <figcaption>
        {label}
        {url ? (
          <a href={url} target="_blank" rel="noopener noreferrer">
            원본 크기로 열기
          </a>
        ) : null}
      </figcaption>
      {url ? (
        <a href={url} target="_blank" rel="noopener noreferrer">
          <img src={url} alt={`${label} 비교 이미지`} />
        </a>
      ) : error ? (
        <div role="alert">
          <p>{error}</p>
          <button type="button" onClick={() => setRetry((value) => value + 1)}>
            이미지 다시 불러오기
          </button>
        </div>
      ) : (
        <p role="status">이미지 불러오는 중…</p>
      )}
    </figure>
  );
}
export function ComparisonPanel({
  state,
  token,
  options,
}: {
  state: ComparisonState;
  token: string;
  options: BridgeRequestOptions;
}) {
  const [selected, setSelected] = useState<number | null>(null);
  const iteration =
    state.iterations.find((item) => item.iteration === selected) ??
    state.iterations.at(-1);
  return (
    <section class="comparison-panel" aria-label="Figma 디자인 비교">
      <header>
        <h3>Figma 디자인 비교</h3>
        <span role="status">
          {STATUS_LABELS[state.status]} · {state.iteration}/
          {state.maxIterations}회
        </span>
      </header>
      <p>
        <a href={state.url} target="_blank" rel="noopener noreferrer">
          Figma 기준 프레임 열기
        </a>
      </p>
      {state.message ? <p class="comparison-message">{state.message}</p> : null}
      <p class="comparison-criteria">
        {state.targetMatch !== undefined && state.threshold !== undefined
          ? `판정 기준: 전체·각 영역 ${state.targetMatch}% 이상 · RGB 차이 허용 ${state.threshold}/255 · 구조 불일치·누락 0`
          : "이 기록에는 일치율 기준과 RGB 허용치가 저장되어 있지 않습니다."}
      </p>
      {iteration ? (
        <>
          <label class="comparison-iteration">
            비교 회차{" "}
            <select
              value={selected ?? "latest"}
              onChange={(event) =>
                setSelected(
                  event.currentTarget.value === "latest"
                    ? null
                    : Number(event.currentTarget.value),
                )
              }
            >
              <option value="latest">최신 회차 자동 표시</option>
              {state.iterations.map((item) => (
                <option key={item.iteration} value={item.iteration}>
                  {item.iteration}회 · {item.overallMatch.toFixed(2)}%
                </option>
              ))}
            </select>
          </label>
          <dl class="comparison-metrics">
            <div>
              <dt>전체 일치율</dt>
              <dd>{iteration.overallMatch.toFixed(2)}%</dd>
            </div>
            <div>
              <dt>구조 불일치</dt>
              <dd>{iteration.structuralMismatches}</dd>
            </div>
            <div>
              <dt>누락 대상</dt>
              <dd>{iteration.missingTargets}</dd>
            </div>
          </dl>
          <details>
            <summary>영역별 일치율</summary>
            <dl class="comparison-regions">
              {Object.entries(iteration.regions).map(([name, score]) => (
                <div key={name}>
                  <dt>{name}</dt>
                  <dd>{score.toFixed(2)}%</dd>
                </div>
              ))}
            </dl>
          </details>
          {iteration.issues.length ? (
            <ul class="comparison-issues">
              {iteration.issues.map((issue, index) => (
                <li key={index}>{issue}</li>
              ))}
            </ul>
          ) : (
            <p>
              이 회차에서 보고된 구조·시각 차이 없음. 최종 상태는 위 비교 결과를
              확인하세요.
            </p>
          )}
          <div class="comparison-images">
            <ComparisonImage
              key={iteration.referenceArtifactId}
              id={iteration.referenceArtifactId}
              label="Figma 기준"
              token={token}
              options={options}
            />
            <ComparisonImage
              key={iteration.screenshotArtifactId}
              id={iteration.screenshotArtifactId}
              label="현재 탭 캡처"
              token={token}
              options={options}
            />
            <ComparisonImage
              key={iteration.heatmapArtifactId}
              id={iteration.heatmapArtifactId}
              label="픽셀 차이"
              token={token}
              options={options}
            />
            <ComparisonImage
              key={iteration.overlayArtifactId}
              id={iteration.overlayArtifactId}
              label="기준·현재 겹쳐 보기"
              token={token}
              options={options}
            />
          </div>
        </>
      ) : (
        <p>
          아직 완료된 비교 회차가 없습니다. 점수는 실제 캡처 비교 후 표시됩니다.
        </p>
      )}
    </section>
  );
}
