import { useAtomValue } from "@effect/atom-react";
import type {
  DesktopPreviewBridge,
  DesktopPreviewWebviewConfig,
  EnvironmentId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import { previewBridge } from "~/components/preview/previewBridge";

const PREVIEW_CONFIG_STALE_TIME_MS = 5 * 60_000;
const PREVIEW_CONFIG_IDLE_TTL_MS = 10 * 60_000;

export class PreviewWebviewBridgeUnavailableError extends Schema.TaggedErrorClass<PreviewWebviewBridgeUnavailableError>()(
  "PreviewWebviewBridgeUnavailableError",
  { environmentId: Schema.String },
) {
  override get message(): string {
    return `Desktop preview configuration is unavailable for environment "${this.environmentId}".`;
  }
}

export class PreviewWebviewConfigLoadError extends Schema.TaggedErrorClass<PreviewWebviewConfigLoadError>()(
  "PreviewWebviewConfigLoadError",
  {
    environmentId: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to load desktop preview configuration for environment "${this.environmentId}".`;
  }
}

export const PreviewWebviewConfigError = Schema.Union([
  PreviewWebviewBridgeUnavailableError,
  PreviewWebviewConfigLoadError,
]);
export type PreviewWebviewConfigError = typeof PreviewWebviewConfigError.Type;

type PreviewConfigBridge = Pick<DesktopPreviewBridge, "getPreviewConfig">;

export const loadPreviewWebviewConfig = (
  environmentId: EnvironmentId,
  profileId?: string,
  browserScope?: string,
  bridge: PreviewConfigBridge | null = previewBridge,
): Effect.Effect<DesktopPreviewWebviewConfig, PreviewWebviewConfigError> => {
  if (bridge === null) {
    return Effect.fail(new PreviewWebviewBridgeUnavailableError({ environmentId }));
  }

  return Effect.tryPromise({
    try: () => bridge.getPreviewConfig(environmentId, profileId, browserScope),
    catch: (cause) => new PreviewWebviewConfigLoadError({ environmentId, cause }),
  });
};

// One value key retains each environment, managed profile, and legacy scope separately.
const configKey = (
  environmentId: EnvironmentId,
  profileId?: string,
  browserScope?: string,
): string => JSON.stringify([environmentId, profileId ?? null, browserScope ?? null]);

const parseConfigKey = (key: string) => {
  const [environmentId, profileId, browserScope] = JSON.parse(key) as [
    EnvironmentId,
    string | null,
    string | null,
  ];
  return {
    environmentId,
    profileId: profileId ?? undefined,
    browserScope: browserScope ?? undefined,
  };
};

const previewWebviewConfigAtom = Atom.family((key: string) => {
  const { environmentId, profileId, browserScope } = parseConfigKey(key);
  return Atom.make(loadPreviewWebviewConfig(environmentId, profileId, browserScope)).pipe(
    Atom.swr({
      staleTime: PREVIEW_CONFIG_STALE_TIME_MS,
      revalidateOnMount: true,
    }),
    Atom.setIdleTTL(PREVIEW_CONFIG_IDLE_TTL_MS),
    Atom.withLabel(`preview:webview-config:${key}`),
  );
});

export function usePreviewWebviewConfig(
  environmentId: EnvironmentId,
  profileId?: string,
  browserScope?: string,
): DesktopPreviewWebviewConfig | null {
  const result = useAtomValue(
    previewWebviewConfigAtom(configKey(environmentId, profileId, browserScope)),
  );
  return Option.getOrNull(AsyncResult.value(result));
}
