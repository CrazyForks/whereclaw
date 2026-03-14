import {
  areLocalModelNamesEquivalent,
  normalizeLocalModelName,
} from './localModelName.ts';

export type LocalModelDownloadProgressSnapshot = {
  running: boolean;
  downloading: boolean;
  model: string;
  success: boolean;
};

export type GatewayStartStateInput = {
  configured: boolean;
  isStartingGateway: boolean;
  isStoppingGateway: boolean;
  isResettingOpenClaw: boolean;
  configuredCurrentModelRequiresExistingLocalModel: boolean;
  configuredCurrentModelName: string;
  configuredLocalModelExists: boolean | null;
  localModelRunProgress: LocalModelDownloadProgressSnapshot | null;
};

export type GatewayStartState = {
  disabled: boolean;
  showDownloadHint: boolean;
};

export function isDownloadingRequiredLocalModel(
  configuredCurrentModelRequiresExistingLocalModel: boolean,
  configuredCurrentModelName: string,
  configuredLocalModelExists: boolean | null,
  localModelRunProgress: LocalModelDownloadProgressSnapshot | null,
): boolean {
  if (!configuredCurrentModelRequiresExistingLocalModel) return false;
  if (configuredLocalModelExists !== false) return false;
  if (!localModelRunProgress?.running || !localModelRunProgress.downloading) return false;

  return areLocalModelNamesEquivalent(
    configuredCurrentModelName,
    localModelRunProgress.model,
  );
}

export function isRequiredLocalModelAvailableForGateway(input: {
  configuredCurrentModelRequiresExistingLocalModel: boolean;
  configuredCurrentModelName: string;
  configuredLocalModelExists: boolean | null;
  localModelRunProgress: LocalModelDownloadProgressSnapshot | null;
}): boolean {
  if (!input.configuredCurrentModelRequiresExistingLocalModel) return true;
  if (input.configuredLocalModelExists === true) return true;

  const configuredModelName = normalizeLocalModelName(
    input.configuredCurrentModelName,
  );
  if (configuredModelName.length === 0) return false;

  return (
    input.localModelRunProgress?.success === true &&
    input.localModelRunProgress.running === false &&
    areLocalModelNamesEquivalent(
      input.localModelRunProgress.model,
      input.configuredCurrentModelName,
    )
  );
}

export function getGatewayStartState(
  input: GatewayStartStateInput,
): GatewayStartState {
  const showDownloadHint = isDownloadingRequiredLocalModel(
    input.configuredCurrentModelRequiresExistingLocalModel,
    input.configuredCurrentModelName,
    input.configuredLocalModelExists,
    input.localModelRunProgress,
  );

  return {
    disabled:
      !input.configured ||
      input.isStartingGateway ||
      input.isStoppingGateway ||
      input.isResettingOpenClaw ||
      showDownloadHint,
    showDownloadHint,
  };
}


export type GatewayStatusCardState = {
  showDownloadHintInCard: boolean;
};

export function getGatewayStatusCardState(
  _input: GatewayStartStateInput,
): GatewayStatusCardState {
  return {
    showDownloadHintInCard: false,
  };
}

export function shouldRefreshAfterLocalModelDownload(input: {
  previousProgress: LocalModelDownloadProgressSnapshot | null;
  nextProgress: LocalModelDownloadProgressSnapshot | null;
  configuredCurrentModelRequiresExistingLocalModel: boolean;
  configuredCurrentModelName: string;
}): boolean {
  if (!input.configuredCurrentModelRequiresExistingLocalModel) return false;
  const configuredModelName = normalizeLocalModelName(input.configuredCurrentModelName);
  if (configuredModelName.length === 0) return false;

  const previousWasDownloading =
    input.previousProgress?.running === true &&
    input.previousProgress.downloading === true &&
    areLocalModelNamesEquivalent(
      input.previousProgress.model,
      input.configuredCurrentModelName,
    );
  const nextFinishedSuccessfully =
    input.nextProgress?.running === false &&
    input.nextProgress?.success === true &&
    areLocalModelNamesEquivalent(
      input.nextProgress.model,
      input.configuredCurrentModelName,
    );

  return previousWasDownloading && nextFinishedSuccessfully;
}
