import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  getChannelContinueButtonState,
  type InitialChannelSelection,
} from "./onboarding/channelStep.ts";
import { getModelStepUiState } from "./onboarding/modelStep.ts";
import { toRenderableWeixinQrSrc } from "./onboarding/weixinQr.ts";
import {
  getGatewayStartState,
  getGatewayStatusCardState,
  isDownloadingRequiredLocalModel,
  isRequiredLocalModelAvailableForGateway,
  shouldRefreshAfterLocalModelDownload,
} from "./runtime/gatewayState.ts";
import {
  areLocalModelNamesEquivalent,
  filterVisibleLocalModels,
  hasLocalModelSelectionChanged,
} from "./runtime/localModelName.ts";

type LauncherLanguage = "en" | "zh-CN";

type LauncherPreferences = {
  language: LauncherLanguage;
  installDir: string;
  hasSavedPreferences: boolean;
  isInitialized: boolean;
  isInitializationInProgress: boolean;
};

type SetupInfo = {
  configured: boolean;
  buildVariant: "local" | "cloud";
  supportsLocalModels: boolean;
  openclawHome: string;
  configPath: string;
  currentModelRef: string;
  currentModelName: string;
  currentModelProvider: string;
  currentModelIsLocal: boolean;
};

type GatewayStatus = {
  running: boolean;
  pid: number | null;
  url: string;
};

type OllamaStatus = {
  running: boolean;
  pid: number | null;
  url: string;
  modelsDir: string;
  version: string | null;
};

type LocalModelRunProgress = {
  running: boolean;
  downloading: boolean;
  hasKnownProgress: boolean;
  progress: number;
  completedBytes: number | null;
  totalBytes: number | null;
  speedBytesPerSec: number | null;
  model: string;
  message: string;
  success: boolean;
  error: string | null;
};

type LocalModelValidationResult = {
  ready: boolean;
  reason: string | null;
};

type ChannelAccount = {
  channel: string;
  accountId: string;
};

type ModelCatalogEntry = {
  key: string;
  provider: string;
  modelId: string;
  name: string;
  input: string | null;
  contextWindow: number | null;
  local: boolean;
  available: boolean;
  tags: string[];
  missing: boolean;
  isCurrent: boolean;
};

type InstalledSkillEntry = {
  id: string;
  skillKey: string;
  title: string;
  description: string | null;
  source: string;
  path: string;
  hasReferences: boolean;
  hasScripts: boolean;
  enabled: boolean;
};

const MIN_LAUNCH_SPLASH_MS = 2000;

const LOCAL_MODEL_OPTIONS = [
  { name: "qwen3.5:0.8b", sizeGb: 1.0 },
  { name: "qwen3.5:2b", sizeGb: 2.7 },
  { name: "qwen3.5:4b", sizeGb: 3.4 },
  { name: "qwen3.5:9b", sizeGb: 6.6 },
  { name: "qwen3.5:27b", sizeGb: 17 },
  { name: "qwen3.5:35b", sizeGb: 24 },
  { name: "qwen3.5:122b", sizeGb: 81 },
] as const;

const FALLBACK_LOCAL_MODEL_NAME = LOCAL_MODEL_OPTIONS[0].name;
const QQ_GROUP_NUMBER = "1029515693";

async function copyTextToClipboard(text: string) {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  if (typeof document === "undefined") {
    throw new Error("Clipboard API unavailable");
  }

  const textArea = document.createElement("textarea");
  textArea.value = text;
  textArea.setAttribute("readonly", "true");
  textArea.style.position = "fixed";
  textArea.style.top = "0";
  textArea.style.left = "0";
  textArea.style.opacity = "0";
  textArea.style.pointerEvents = "none";

  document.body.appendChild(textArea);
  textArea.focus();
  textArea.select();
  textArea.setSelectionRange(0, text.length);

  try {
    const copied = document.execCommand("copy");
    if (!copied) {
      throw new Error("execCommand copy returned false");
    }
  } finally {
    document.body.removeChild(textArea);
  }
}

function getRecommendedLocalModelName(
  recommendedLimitGb: number | null,
): string {
  if (recommendedLimitGb === null) return FALLBACK_LOCAL_MODEL_NAME;

  const matchedModel = [...LOCAL_MODEL_OPTIONS]
    .reverse()
    .find((model) => model.sizeGb <= recommendedLimitGb);

  return matchedModel?.name ?? FALLBACK_LOCAL_MODEL_NAME;
}

type StatusLogLevel = "INFO" | "WARN" | "ERROR";
type StatusLogContext = Record<string, unknown>;

type InitialSetupConfigRequest = {
  localModel?: string;
  cloudModel?: {
    baseUrl: string;
    apiKey: string;
    model: string;
  };
  channelSelection?: InitialChannelSelection;
  qq?: {
    appId: string;
    appSecret: string;
  };
};

type StartWeixinLoginResult = {
  qrDataUrl: string | null;
  sessionKey: string;
  message: string;
};

type WaitWeixinLoginResult = {
  connected: boolean;
  accountId: string | null;
  message: string;
};

type SystemMemoryInfo = {
  totalRamBytes: number;
  gpuTotalBytes: number | null;
};

type Screen = "language" | "model" | "channel" | "main";
type MainNav = "overview" | "config" | "logs";
type ConfigPage = "local-model" | "channel" | "model" | "skill";
type LocalModelToggleAction = "enable" | "disable";
type LogSource = "launcher" | "ollama" | "gateway";

type LocalModelPageDraft = {
  toggleEnabled: boolean;
  pendingSelection: string;
  pickerDraft: string;
  isAddingModel: boolean;
};

type Copy = {
  brandName: string;
  brandSlogan: (openclawVersion: string | null) => string;
  officialWebsiteLabel: string;
  updateAvailableLabel: string;
  consoleVersionName: string;
  navOverview: string;
  navConfig: string;
  navLogs: string;
  navMore: string;
  logSourceLauncher: string;
  logSourceOllama: string;
  logSourceGateway: string;
  logsAutoRefresh: string;
  logsJumpToLatest: string;
  currentStatusTitle: string;
  resetConfirmMessage: string;
  resetConfirmAction: string;
  selected: string;
  saving: string;
  loading: string;
  modelQuestion: string;
  cloudModelQuestion: string;
  channelQuestion: string;
  channelDescription: string;
  channelWeixinLabel: string;
  channelQqLabel: string;
  channelSkipLabel: string;
  weixinDescription: string;
  weixinStepTitle: string;
  weixinStepLines: string[];
  weixinQrPending: string;
  weixinQrReady: string;
  weixinQrExpired: string;
  weixinQrWaiting: string;
  weixinLoginFailed: string;
  weixinLoginRetry: string;
  weixinQrAlt: string;
  qqDescription: string;
  qqStepTitle: string;
  qqStepLines: string[];
  qqStepLinkLabel: string;
  qqAppIdLabel: string;
  qqAppSecretLabel: string;
  yes: string;
  no: string;
  modelNameLabel: string;
  cloudBaseUrlLabel: string;
  cloudApiKeyLabel: string;
  cloudModelNameLabel: string;
  cloudConfigHint: string;
  cloudBaseUrlPlaceholder: string;
  cloudApiKeyPlaceholder: string;
  cloudModelNamePlaceholder: string;
  modelNameValidationEmpty: string;
  cloudBaseUrlValidationEmpty: string;
  cloudApiKeyValidationEmpty: string;
  cloudModelValidationEmpty: string;
  cloudBaseUrlInvalid: string;
  modelNameInvalid: string;
  modelNameCloudHint: string;
  modelNoLocalHint: string;
  modelSearchInstructionPrefix: string;
  modelSearchInstructionExample: string;
  modelSearchLinkLabel: string;
  backAriaLabel: string;
  nextAriaLabel: string;
  validatingModel: string;
  heroKicker: string;
  heroTitle: string;
  heroDescription: string;
  setupConfigured: string;
  setupRequired: string;
  setupLabel: string;
  gatewayLabel: string;
  runtimeLabel: string;
  controlsKicker: string;
  controlsTitle: string;
  controlsDescription: string;
  preferences: string;
  languageSheetTitle: string;
  languageSheetDescription: string;
  openSetup: string;
  openTerminal: string;
  openConfigFile: string;
  qqGroupMenuLabel: string;
  qqGroupCopied: string;
  qqGroupCopyFailed: string;
  setupConfirmTitle: string;
  setupConfirmMessage: string;
  openingSetup: string;
  openingTerminal: string;
  channelManager: string;
  modelManager: string;
  resetOpenClaw: string;
  resettingOpenClaw: string;
  startGateway: string;
  startingGateway: string;
  stopGateway: string;
  stoppingGateway: string;
  openControlUi: string;
  runtimeStatusTitle: string;
  refresh: string;
  pending: string;
  ollamaTitle: string;
  currentModelLabel: string;
  currentModelUnconfigured: string;
  currentModelLocalSummary: string;
  currentModelNonLocalSummary: string;
  localModelToggleLabel: string;
  localModelToggleEnabled: string;
  localModelToggleDisabled: string;
  localModelToggleServiceReady: string;
  localModelToggleEnableHint: string;
  localModelToggleDisableHint: string;
  localModelToggleServiceReadyHint: string;
  localModelToggleEnableConfirm: string;
  localModelToggleDisableConfirm: string;
  localModelTogglePendingDisable: string;
  localModelToggleTurnOn: string;
  localModelToggleTurnOff: string;
  localModelToggleGoCloud: string;
  modelPickerLoading: string;
  modelPickerEmpty: string;
  modelPickerAddModel: string;
  modelPickerCancelAdd: string;
  modelPickerDownloadModel: string;
  modelPickerDownloadingModel: string;
  channelManagerTitle: string;
  channelManagerLoading: string;
  channelManagerEmpty: string;
  channelManagerAdd: string;
  channelManagerAddConfirmTitle: string;
  channelManagerAddConfirmMessage: string;
  channelManagerRemoving: string;
  channelLabel: string;
  accountLabel: string;
  remove: string;
  modelManagerTitle: string;
  modelManagerLoading: string;
  modelManagerEmpty: string;
  modelManagerAddProvider: string;
  modelManagerAddModel: string;
  modelManagerSearchPlaceholder: string;
  modelManagerAddConfirmTitle: string;
  modelManagerAddConfirmMessage: string;
  providerLabel: string;
  modelInputLabel: string;
  modelContextLabel: string;
  close: string;
  ollamaRunning: string;
  ollamaOffline: string;
  startOllama: string;
  startingOllama: string;
  stopOllama: string;
  stoppingOllama: string;
  pullModel: string;
  pullingModel: string;
  modelPlaceholder: string;
  memoryInfoTitle: string;
  memoryRamLabel: string;
  memoryGpuLabel: string;
  memoryModelLimit: string;
  memoryInfoDetecting: string;
  memoryInfoUnavailable: string;
  versionLabel: string;
  pidLabel: string;
  modelsDirLabel: string;
  loadFailed: string;
  saveFailed: string;
  setupFailed: string;
  startFailed: string;
  stopFailed: string;
  openUiFailed: string;
  startOllamaFailed: string;
  stopOllamaFailed: string;
  pullModelFailed: string;
  validateModelNameFailed: string;
  applyInitialSetupFailed: string;
  listModelsFailed: string;
  listChannelsFailed: string;
  removeChannelFailed: string;
  openChannelWizardFailed: string;
  listOpenClawModelsFailed: string;
  openModelProviderWizardFailed: string;
  openModelWizardFailed: string;
  switchModelFailed: string;
  resetOpenClawFailed: string;
  openTerminalFailed: string;
  openConfigFileFailed: string;
  statusSetupRequired: string;
  statusStartGatewayRequiresOllama: string;
  statusStartGatewayRequiresLocalModel: string;
  statusStartGatewayWaitForModelDownload: (modelName: string) => string;
  loadInstalledSkillsFailed: string;
  toggleSkillFailed: string;
  openSkillCatalogFailed: string;
  installSkillFailed: string;
  installSkillSuccess: (slug: string) => string;
  removeSkillSuccess: (slug: string) => string;
  removeSkillFailed: string;
  stopDownloadFailed: string;
  stopDownload: string;
  stopDownloadConfirm: string;
  confirmStop: string;
  configCenterTitle: string;
  configCenterBackAriaLabel: string;
  configCenterBreadcrumb: string;
  localModelConfigTitle: string;
  localModelConfigDescription: string;
  configCenterLocalModelTitle: string;
  configCenterLocalModelDescription: string;
  configCenterChannelTitle: string;
  configCenterChannelDescription: string;
  configCenterModelTitle: string;
  configCenterModelDescription: string;
  configCenterSkillTitle: string;
  configCenterSkillDescription: string;
  downloadPreparing: string;
  save: string;
  channelConfigDescription: string;
  modelConfigDescription: string;
  skillManagementTitle: string;
  skillManagementDescription: string;
  installedSkillsTitle: string;
  installedSkillsSummary: (count: number) => string;
  openSkillCatalog: string;
  refreshSkillList: string;
  loadingSkillList: string;
  installedSkillsEmpty: string;
  skillSourceWorkspace: string;
  skillSourceManaged: string;
  skillSourceBundled: string;
  skillEnabled: string;
  skillDisabled: string;
  disableSkill: string;
  enableSkill: string;
  deleteSkill: string;
  skillManagementBackAriaLabel: string;
  removeSkillTitle: string;
  removeWorkspaceSkillConfirm: (slug: string) => string;
  removing: string;
  confirmDelete: string;
  languages: Array<{
    code: LauncherLanguage;
    label: string;
  }>;
};

const copyByLanguage: Record<LauncherLanguage, Copy> = {
  en: {
    brandName: "WhereClaw",
    brandSlogan: (openclawVersion) =>
      `The original official OpenClaw little lobster 🦞. OpenClaw v${
        openclawVersion ?? "..."
      }. Run local models for free, eliminate token anxiety, and deploy with zero-config in one click.`,
    officialWebsiteLabel: "Official Website",
    updateAvailableLabel: "Update available",
    consoleVersionName: "Console",
    navOverview: "Overview",
    navConfig: "Config",
    navLogs: "Logs",
    navMore: "More",
    logSourceLauncher: "WhereClaw",
    logSourceOllama: "Local Model",
    logSourceGateway: "Gateway",
    logsAutoRefresh: "Auto-refresh every 2s",
    logsJumpToLatest: "Jump to latest",
    currentStatusTitle: "Current Status",
    resetConfirmMessage: "Reset OpenClaw and restart the initialization flow?",
    resetConfirmAction: "Reset And Reinitialize",
    selected: "Selected",
    saving: "Saving...",
    loading: "Loading...",
    modelQuestion: "Run a local model?",
    cloudModelQuestion: "Connect a cloud model?",
    channelQuestion: "Connect a chat channel?",
    channelDescription: "Choose the channel to connect during initialization.",
    channelWeixinLabel: "WeChat",
    channelQqLabel: "QQ",
    channelSkipLabel: "Skip For Now",
    weixinDescription:
      "Please ensure that WeChat is updated to the latest version and complete the QR code login here.",
    weixinStepTitle: "WeChat Login",
    weixinStepLines: [
      "Click next to start QR login.",
      "Scan the QR code with WeChat on your phone.",
      "Wait for authorization to complete here.",
    ],
    weixinQrPending: "Click next to generate a WeChat QR code.",
    weixinQrReady: "Scan this QR code with WeChat to continue.",
    weixinQrExpired: "The QR code expired. Click next to generate a new one.",
    weixinQrWaiting: "Waiting for WeChat authorization...",
    weixinLoginFailed: "WeChat login failed.",
    weixinLoginRetry: "Retry WeChat Login",
    weixinQrAlt: "WeChat login QR code",
    qqDescription: "You can chat with OpenClaw through QQ after setup.",
    qqStepTitle: "Setup Steps",
    qqStepLines: [
      'Sign in and click "Create Bot".',
      "Copy the AppID and App Secret.",
      "Fill them in below, then continue.",
    ],
    qqStepLinkLabel: "Open QQ Open Platform",
    qqAppIdLabel: "AppID",
    qqAppSecretLabel: "App Secret",
    yes: "Yes",
    no: "No",
    modelNameLabel: "Enter model name",
    cloudBaseUrlLabel: "OpenAI-compatible Base URL",
    cloudApiKeyLabel: "API Key",
    cloudModelNameLabel: "Model Name",
    cloudConfigHint:
      "Default provider mode uses `openai-completions`. Please select 'No' for other models; they can be added later in model management.",
    cloudBaseUrlPlaceholder: "https://api.deepseek.com/",
    cloudApiKeyPlaceholder: "sk-...",
    cloudModelNamePlaceholder: "deepseek-chat",
    modelNameValidationEmpty: "Enter a model name first.",
    cloudBaseUrlValidationEmpty: "Enter a base URL first.",
    cloudApiKeyValidationEmpty: "Enter an API key first.",
    cloudModelValidationEmpty: "Enter a model name first.",
    cloudBaseUrlInvalid: "Base URL must start with http:// or https://.",
    modelNameInvalid: "Model name is invalid.",
    modelNameCloudHint:
      "This model is a cloud model, not a local model. Please use a local model name.",
    modelNoLocalHint:
      "OpenClaw needs at least one model. You can later add a cloud model or a local model in Config → Model Manager.",
    modelSearchInstructionPrefix: "Find models here, e.g. ",
    modelSearchInstructionExample: "qwen3.5:0.8b",
    modelSearchLinkLabel: "ollama.com/search",
    backAriaLabel: "Back",
    nextAriaLabel: "Next",
    validatingModel: "Validating model...",
    heroKicker: "WhereClaw Launcher",
    heroTitle: "Choose your language, then continue with the launcher.",
    heroDescription:
      "Use the official setup flow, start the local runtime, and open the Control UI from one place.",
    setupConfigured: "Core setup already saved",
    setupRequired: "Core setup required",
    setupLabel: "Setup",
    gatewayLabel: "Gateway",
    runtimeLabel: "Runtime",
    controlsKicker: "Controls",
    controlsTitle: "Launcher",
    controlsDescription:
      "Use the previous launcher page layout and keep the main actions here.",
    preferences: "Change Language",
    languageSheetTitle: "Select Language",
    languageSheetDescription: "Switch launcher language.",
    openSetup: "Official Initialization",
    openTerminal: "WhereClaw Terminal",
    openConfigFile: "Config File",
    qqGroupMenuLabel: `QQ Group ${QQ_GROUP_NUMBER}`,
    qqGroupCopied: `QQ group number copied: ${QQ_GROUP_NUMBER}`,
    qqGroupCopyFailed: "Failed to copy QQ group number.",
    setupConfirmTitle: "Open Official Initialization",
    setupConfirmMessage:
      "This will open the official initialization flow. Continue?",
    openingSetup: "Opening...",
    openingTerminal: "Opening terminal...",
    channelManager: "Channel Manager",
    modelManager: "Model Manager",
    resetOpenClaw: "Reset OpenClaw Config",
    resettingOpenClaw: "Resetting...",
    startGateway: "Start Gateway",
    startingGateway: "Starting...",
    stopGateway: "Stop Gateway",
    stoppingGateway: "Stopping...",
    openControlUi: "Open Control UI",
    runtimeStatusTitle: "Runtime Status",
    refresh: "Refresh",
    pending: "Pending",
    ollamaTitle: "Local Model",
    currentModelLabel: "Current model",
    currentModelUnconfigured: "No model configured",
    currentModelLocalSummary: "Local model",
    currentModelNonLocalSummary: "Non-local model",
    localModelToggleLabel: "Local model",
    localModelToggleEnabled: "Local model enabled",
    localModelToggleDisabled: "Local model disabled",
    localModelToggleServiceReady: "Local model service is running",
    localModelToggleEnableHint:
      "Turning this on will switch OpenClaw away from cloud providers and use the local model as the primary model.",
    localModelToggleDisableHint:
      "Turning this off requires a cloud model to become the primary model. OpenClaw must always keep one model active.",
    localModelToggleServiceReadyHint:
      "Ollama is running. Select a local model and save it before switching OpenClaw to local mode.",
    localModelToggleEnableConfirm:
      "Enable local model mode? This will disable the current cloud model.",
    localModelToggleDisableConfirm:
      "Disable local model mode? OpenClaw must keep one active model, so local mode will only fully turn off after you switch the primary model to a cloud provider.",
    localModelTogglePendingDisable:
      "Please switch the primary model to a cloud provider to finish turning off local mode.",
    localModelToggleTurnOn: "Turn On",
    localModelToggleTurnOff: "Turn Off",
    localModelToggleGoCloud: "Go To Cloud Models",
    modelPickerLoading: "Loading models...",
    modelPickerEmpty: "No local models found. Pull one first.",
    modelPickerAddModel: "Add Model",
    modelPickerCancelAdd: "Cancel",
    modelPickerDownloadModel: "Download Model",
    modelPickerDownloadingModel: "Downloading...",
    channelManagerTitle: "Channel Management",
    channelManagerLoading: "Loading channels...",
    channelManagerEmpty: "No channel account found.",
    channelManagerAdd: "Add Channel",
    channelManagerAddConfirmTitle: "Open Official Channel Setup",
    channelManagerAddConfirmMessage:
      'After finishing, select "Completed" and press Enter.',
    channelManagerRemoving: "Removing...",
    channelLabel: "Channel",
    accountLabel: "Account",
    remove: "Remove",
    modelManagerTitle: "Model Management",
    modelManagerLoading: "Loading providers and models...",
    modelManagerEmpty: "No providers or models found.",
    modelManagerAddProvider: "Add Provider",
    modelManagerAddModel: "Add Model",
    modelManagerSearchPlaceholder: "Search provider or model",
    modelManagerAddConfirmTitle: "Open Model Provider Setup",
    modelManagerAddConfirmMessage:
      "This will open the system model provider setup wizard. Continue?",
    providerLabel: "Provider",
    modelInputLabel: "Input",
    modelContextLabel: "Context",
    close: "Close",
    ollamaRunning: "Running",
    ollamaOffline: "Offline",
    startOllama: "Start Service",
    startingOllama: "Starting service...",
    stopOllama: "Stop Service",
    stoppingOllama: "Stopping service...",
    pullModel: "Pull Model",
    pullingModel: "Pulling...",
    modelPlaceholder: "qwen3.5:0.8b",
    memoryInfoTitle: "Device resources",
    memoryRamLabel: "RAM",
    memoryGpuLabel: "GPU memory",
    memoryModelLimit: "Recommended maximum model size:",
    memoryInfoDetecting: "Detecting available memory...",
    memoryInfoUnavailable: "Unable to detect memory details.",
    versionLabel: "Version",
    pidLabel: "PID",
    modelsDirLabel: "Models Directory",
    loadFailed: "Failed to load launcher data.",
    saveFailed: "Failed to save launcher preferences.",
    setupFailed: "Failed to open setup.",
    startFailed: "Failed to start gateway.",
    stopFailed: "Failed to stop gateway.",
    openUiFailed: "Failed to open UI.",
    startOllamaFailed: "Failed to start Ollama.",
    stopOllamaFailed: "Failed to stop Ollama.",
    pullModelFailed: "Failed to pull model.",
    validateModelNameFailed: "Failed to validate model name.",
    applyInitialSetupFailed: "Failed to generate initial OpenClaw config.",
    listModelsFailed: "Failed to load model list.",
    listChannelsFailed: "Failed to load channel list.",
    removeChannelFailed: "Failed to remove channel account.",
    openChannelWizardFailed: "Failed to open channel add wizard.",
    listOpenClawModelsFailed: "Failed to load providers and models.",
    openModelProviderWizardFailed: "Failed to open provider auth flow.",
    openModelWizardFailed: "Failed to open model setup flow.",
    switchModelFailed: "Failed to switch current model.",
    resetOpenClawFailed: "Failed to reset OpenClaw config.",
    openTerminalFailed: "Failed to open WhereClaw terminal.",
    openConfigFileFailed: "Failed to open OpenClaw config file.",
    statusSetupRequired:
      "At least one model must be configured before startup.",
    statusStartGatewayRequiresOllama:
      "Start the local model service before starting the gateway.",
    statusStartGatewayRequiresLocalModel:
      "Local model does not exist. Add a local model or switch models before starting the gateway.",
    statusStartGatewayWaitForModelDownload: (modelName) =>
      `Model ${modelName} is downloading. Wait for the download to finish, then start the gateway.`,
    loadInstalledSkillsFailed: "Failed to load installed skills.",
    toggleSkillFailed: "Failed to change skill status.",
    openSkillCatalogFailed: "Failed to open skill catalog.",
    installSkillFailed: "Failed to install skill.",
    installSkillSuccess: (slug) => `Skill ${slug} installed successfully.`,
    removeSkillSuccess: (slug) => `Skill ${slug} was removed.`,
    removeSkillFailed: "Failed to remove skill.",
    stopDownloadFailed: "Failed to stop download.",
    stopDownload: "Stop Download",
    stopDownloadConfirm: "Stop the current model download?",
    confirmStop: "Confirm Stop",
    configCenterTitle: "Configuration Center",
    configCenterBackAriaLabel: "Back to configuration center",
    configCenterBreadcrumb: "Configuration Center",
    localModelConfigTitle: "Local Model Settings",
    localModelConfigDescription:
      "Control the local model service, and manage local model downloads, validation, and switching.",
    configCenterLocalModelTitle: "Local Model Settings",
    configCenterLocalModelDescription:
      "Manage local model selection, downloads, and switching for this device.",
    configCenterChannelTitle: "Channel Management",
    configCenterChannelDescription:
      "Manage QQ, DingTalk, and other conversation channel accounts in one place.",
    configCenterModelTitle: "Model Management",
    configCenterModelDescription:
      "Manage cloud and local model access, switching, and primary model settings.",
    configCenterSkillTitle: "Skill Management",
    configCenterSkillDescription:
      "Browse the official ClawHub site and install skills through WhereClaw without command-line windows or zip downloads.",
    downloadPreparing: "Preparing download...",
    save: "Save",
    channelConfigDescription:
      "Maintain QQ, DingTalk, and other channel connections to keep message entry points available.",
    modelConfigDescription:
      "Review provider and local model setup, then save to switch the default primary model.",
    skillManagementTitle: "Skill Management",
    skillManagementDescription:
      "Open the official ClawHub site and install skills with one click in WhereClaw. No command-line windows, no zip downloads.",
    installedSkillsTitle: "Installed Skills",
    installedSkillsSummary: (count) =>
      `${count} total, grouped by workspace and bundled sources.`,
    openSkillCatalog: "Open ClawHub",
    refreshSkillList: "Refresh Skill List",
    loadingSkillList: "Loading installed skills...",
    installedSkillsEmpty: "No installed skills found.",
    skillSourceWorkspace: "Workspace Skills",
    skillSourceManaged: "Managed Skills",
    skillSourceBundled: "Bundled Skills",
    skillEnabled: "Enabled",
    skillDisabled: "Disabled",
    disableSkill: "Disable Skill",
    enableSkill: "Enable Skill",
    deleteSkill: "Delete Skill",
    skillManagementBackAriaLabel: "Back to skill management",
    removeSkillTitle: "Delete Skill",
    removeWorkspaceSkillConfirm: (slug) =>
      `Delete workspace skill \`${slug}\`?`,
    removing: "Removing...",
    confirmDelete: "Confirm Delete",
    languages: [
      { code: "en", label: "English" },
      { code: "zh-CN", label: "中文" },
    ],
  },
  "zh-CN": {
    brandName: "WhereClaw自由龙虾",
    brandSlogan: (openclawVersion) =>
      `OpenClaw官方原版小龙虾🦞，OpenClaw v${
        openclawVersion ?? "..."
      }，运行本地模型全免费，告别token焦虑，没有网络问题，零配置轻松一键部署。`,
    officialWebsiteLabel: "官方网站",
    updateAvailableLabel: "发现新版本",
    consoleVersionName: "自由龙虾",
    navOverview: "总览",
    navConfig: "配置",
    navLogs: "日志",
    navMore: "更多",
    logSourceLauncher: "WhereClaw",
    logSourceOllama: "本地模型",
    logSourceGateway: "Gateway",
    logsAutoRefresh: "每 2 秒自动刷新",
    logsJumpToLatest: "跳到最新",
    currentStatusTitle: "当前运行状态",
    resetConfirmMessage: "确定要重置 OpenClaw 并重新进入初始化流程吗？",
    resetConfirmAction: "重置并重新初始化",
    selected: "已选择",
    saving: "正在保存...",
    loading: "加载中...",
    modelQuestion: "是否在本地运行大模型？",
    cloudModelQuestion: "是否接入云端模型？",
    channelQuestion: "是否接入对话通道？",
    channelDescription: "选择要在初始化阶段完成接入的通道。",
    channelWeixinLabel: "微信",
    channelQqLabel: "QQ",
    channelSkipLabel: "暂不接入",
    weixinDescription: "请确保微信升级到最新版，并在这里完成扫码登录。",
    weixinStepTitle: "微信登录",
    weixinStepLines: [
      "点击下一步开始生成微信二维码。",
      "使用手机微信扫码。",
      "等待授权结果返回到当前页面。",
    ],
    weixinQrPending: "点击下一步生成微信二维码。",
    weixinQrReady: "请使用微信扫描此二维码继续。",
    weixinQrExpired: "二维码已过期，请点击下一步重新生成。",
    weixinQrWaiting: "正在等待微信授权...",
    weixinLoginFailed: "微信登录失败。",
    weixinLoginRetry: "重新登录微信",
    weixinQrAlt: "微信登录二维码",
    qqDescription: "配置后可以通过 QQ 和 OpenClaw 沟通。",
    qqStepTitle: "配置步骤",
    qqStepLines: [
      "登录后点击“创建机器人”。",
      "复制 AppID 和 App Secret。",
      "在下方填入后继续下一步。",
    ],
    qqStepLinkLabel: "打开 QQ 开放平台",
    qqAppIdLabel: "AppID",
    qqAppSecretLabel: "App Secret",
    yes: "是",
    no: "否",
    modelNameLabel: "输入模型名称",
    cloudBaseUrlLabel: "OpenAI 兼容 Base URL",
    cloudApiKeyLabel: "API Key",
    cloudModelNameLabel: "模型名称",
    cloudConfigHint:
      "默认使用 `openai-completions`。其他模型请选择'否'，后续在模型管理中添加。",
    cloudBaseUrlPlaceholder: "https://api.deepseek.com/",
    cloudApiKeyPlaceholder: "sk-...",
    cloudModelNamePlaceholder: "deepseek-chat",
    modelNameValidationEmpty: "请先输入模型名称。",
    cloudBaseUrlValidationEmpty: "请先输入 Base URL。",
    cloudApiKeyValidationEmpty: "请先输入 API Key。",
    cloudModelValidationEmpty: "请先输入模型名称。",
    cloudBaseUrlInvalid: "Base URL 必须以 http:// 或 https:// 开头。",
    modelNameInvalid: "模型名称有误。",
    modelNameCloudHint: "此模型属于云端模型，非本地模型，请使用本地模型名称。",
    modelNoLocalHint:
      "OpenClaw 需要至少配置一个模型。您可以后续在配置页面的模型管理中添加云端模型，或者添加本地模型。",
    modelSearchInstructionPrefix: "在这里找到模型，例：",
    modelSearchInstructionExample: "qwen3.5:0.8b",
    modelSearchLinkLabel: "ollama.com/search",
    backAriaLabel: "上一步",
    nextAriaLabel: "下一步",
    validatingModel: "正在验证模型...",
    heroKicker: "WhereClaw 启动器",
    heroTitle: "先选择语言，然后继续使用启动器。",
    heroDescription:
      "在一个页面里完成官方设置、启动本地运行时，并打开 Control UI。",
    setupConfigured: "核心设置已保存",
    setupRequired: "需要先完成核心设置",
    setupLabel: "设置",
    gatewayLabel: "网关",
    runtimeLabel: "运行时",
    controlsKicker: "控制台",
    controlsTitle: "启动器",
    controlsDescription: "恢复之前的主页面布局，核心操作继续放在这里。",
    preferences: "切换语言",
    languageSheetTitle: "选择语言",
    languageSheetDescription: "切换启动器语言。",
    openSetup: "官方初始化",
    openTerminal: "WhereClaw 终端",
    openConfigFile: "配置文件",
    qqGroupMenuLabel: `QQ群${QQ_GROUP_NUMBER}`,
    qqGroupCopied: `已复制QQ群号：${QQ_GROUP_NUMBER}`,
    qqGroupCopyFailed: "复制QQ群号失败。",
    setupConfirmTitle: "打开官方初始化",
    setupConfirmMessage: "将要打开 OpenClaw 官方初始化流程，确认继续吗？",
    openingSetup: "打开中...",
    openingTerminal: "正在打开终端...",
    channelManager: "通道管理",
    modelManager: "模型管理",
    resetOpenClaw: "重置 OpenClaw 配置",
    resettingOpenClaw: "重置中...",
    startGateway: "启动网关",
    startingGateway: "启动中...",
    stopGateway: "停止网关",
    stoppingGateway: "停止中...",
    openControlUi: "打开控制界面",
    runtimeStatusTitle: "运行状态",
    refresh: "刷新",
    pending: "等待中",
    ollamaTitle: "本地模型",
    currentModelLabel: "当前模型",
    currentModelUnconfigured: "无配置模型",
    currentModelLocalSummary: "本地模型",
    currentModelNonLocalSummary: "非本地模型",
    localModelToggleLabel: "本地模型开关",
    localModelToggleEnabled: "已开启本地模型",
    localModelToggleDisabled: "已关闭本地模型",
    localModelToggleServiceReady: "本地模型服务已启动",
    localModelToggleEnableHint:
      "开启后会关闭当前云端模型，并将 OpenClaw 的主模型切换为本地模型。",
    localModelToggleDisableHint:
      "关闭本地模型前，需要先让一个云端模型成为主模型。OpenClaw 必须始终保留一个生效模型。",
    localModelToggleServiceReadyHint:
      "Ollama 已启动，请先选择一个本地模型并保存，然后再让 OpenClaw 切换到本地模型。",
    localModelToggleEnableConfirm:
      "确认开启本地模型吗？开启后会关闭其他云端模型。",
    localModelToggleDisableConfirm:
      "确认关闭本地模型吗？由于 OpenClaw 必须始终保留一个生效模型，只有云端模型成为主模型后，本地模型才会真正关闭。",
    localModelTogglePendingDisable:
      "请先在模型管理里切换到云端主模型，本地模型才会真正关闭。",
    localModelToggleTurnOn: "开启",
    localModelToggleTurnOff: "关闭",
    localModelToggleGoCloud: "前往云端模型",
    modelPickerLoading: "正在加载模型列表...",
    modelPickerEmpty: "未发现本地模型，请先拉取模型。",
    modelPickerAddModel: "新增模型",
    modelPickerCancelAdd: "取消",
    modelPickerDownloadModel: "下载模型",
    modelPickerDownloadingModel: "下载中...",
    channelManagerTitle: "通道管理",
    channelManagerLoading: "正在加载通道列表...",
    channelManagerEmpty: "暂无通道账号。",
    channelManagerAdd: "添加通道",
    channelManagerAddConfirmTitle: "打开官方通道管理",
    channelManagerAddConfirmMessage: "添加完成之后，请选择“已完成”后再按回车。",
    channelManagerRemoving: "删除中...",
    channelLabel: "通道",
    accountLabel: "账号",
    remove: "删除",
    modelManagerTitle: "模型管理",
    modelManagerLoading: "正在加载提供商和模型...",
    modelManagerEmpty: "未找到提供商或模型。",
    modelManagerAddProvider: "添加服务商",
    modelManagerAddModel: "添加模型",
    modelManagerSearchPlaceholder: "搜索服务商或模型",
    modelManagerAddConfirmTitle: "打开模型提供商配置",
    modelManagerAddConfirmMessage: "将要打开系统模型提供商向导，确认继续吗？",
    providerLabel: "服务商",
    modelInputLabel: "输入类型",
    modelContextLabel: "上下文",
    close: "关闭",
    ollamaRunning: "运行中",
    ollamaOffline: "未启动",
    startOllama: "启动服务",
    startingOllama: "服务启动中...",
    stopOllama: "停止服务",
    stoppingOllama: "服务停止中...",
    pullModel: "拉取模型",
    pullingModel: "拉取中...",
    modelPlaceholder: "qwen3.5:0.8b",
    memoryInfoTitle: "设备资源",
    memoryRamLabel: "系统内存",
    memoryGpuLabel: "显存",
    memoryModelLimit: "建议模型大小不超过",
    memoryInfoDetecting: "正在检测可用内存...",
    memoryInfoUnavailable: "暂时无法获取内存信息。",
    versionLabel: "版本",
    pidLabel: "进程 ID",
    modelsDirLabel: "模型目录",
    loadFailed: "加载启动器数据失败。",
    saveFailed: "保存启动器设置失败。",
    setupFailed: "打开设置失败。",
    startFailed: "启动网关失败。",
    stopFailed: "停止网关失败。",
    openUiFailed: "打开界面失败。",
    startOllamaFailed: "启动 Ollama 失败。",
    stopOllamaFailed: "停止 Ollama 失败。",
    pullModelFailed: "拉取模型失败。",
    validateModelNameFailed: "校验模型名称失败。",
    applyInitialSetupFailed: "生成初始 OpenClaw 配置失败。",
    listModelsFailed: "加载模型列表失败。",
    listChannelsFailed: "加载通道列表失败。",
    removeChannelFailed: "删除通道账号失败。",
    openChannelWizardFailed: "打开通道添加流程失败。",
    listOpenClawModelsFailed: "加载服务商和模型失败。",
    openModelProviderWizardFailed: "打开服务商授权流程失败。",
    openModelWizardFailed: "打开模型设置流程失败。",
    switchModelFailed: "切换当前模型失败。",
    resetOpenClawFailed: "重置 OpenClaw 配置失败。",
    openTerminalFailed: "打开 WhereClaw 终端失败。",
    openConfigFileFailed: "打开 OpenClaw 配置文件失败。",
    statusSetupRequired: "需要至少配置一个模型才可以启动。",
    statusStartGatewayRequiresOllama: "请先启动本地模型服务，再启动网关。",
    statusStartGatewayRequiresLocalModel:
      "本地模型不存在，请添加本地模型或切换模型后启动网关。",
    statusStartGatewayWaitForModelDownload: (modelName) =>
      `模型 ${modelName} 正在下载，请等待下载完成后再启动网关。`,
    loadInstalledSkillsFailed: "加载技能列表失败。",
    toggleSkillFailed: "切换技能状态失败。",
    openSkillCatalogFailed: "打开技能广场失败。",
    installSkillFailed: "安装技能失败。",
    installSkillSuccess: (slug) => `技能 ${slug} 安装成功。`,
    removeSkillSuccess: (slug) => `技能 ${slug} 已删除。`,
    removeSkillFailed: "删除技能失败。",
    stopDownloadFailed: "停止下载失败。",
    stopDownload: "停止下载",
    stopDownloadConfirm: "确认停止当前模型下载？",
    confirmStop: "确认停止",
    configCenterTitle: "配置中心",
    configCenterBackAriaLabel: "返回配置中心",
    configCenterBreadcrumb: "配置中心",
    localModelConfigTitle: "本地模型配置",
    localModelConfigDescription:
      "控制本地模型服务，管理下载、验证和切换本地模型作为默认推理模型。",
    configCenterLocalModelTitle: "本地模型配置",
    configCenterLocalModelDescription:
      "管理本地大模型的选择、下载与切换，配置当前设备默认使用的推理模型。",
    configCenterChannelTitle: "通道管理",
    configCenterChannelDescription:
      "统一管理 QQ、钉钉等对话通道的账号接入与消息入口。",
    configCenterModelTitle: "模型管理",
    configCenterModelDescription:
      "统一管理云端与本地模型的接入、切换和主模型设置，维护当前可用模型清单。",
    configCenterSkillTitle: "技能管理",
    configCenterSkillDescription:
      "ClawHub官方镜像站，使用WhereClaw可以一键安装，告别命令行黑框和下载zip。",
    downloadPreparing: "准备下载中...",
    save: "保存",
    channelConfigDescription:
      "统一维护 QQ、钉钉等对话通道的账号连接，确保消息入口稳定可用。",
    modelConfigDescription:
      "汇总所有服务商模型与本地模型的接入配置，点击模型后保存，可以切换默认主模型。",
    skillManagementTitle: "技能管理",
    skillManagementDescription:
      "ClawHub官方镜像站，使用WhereClaw可以一键安装，告别命令行黑框和下载zip。",
    installedSkillsTitle: "已安装技能",
    installedSkillsSummary: (count) =>
      `共 ${count} 个，用户目录与内置目录会分别分组展示。`,
    openSkillCatalog: "打开 ClawHub 官方镜像站",
    refreshSkillList: "刷新技能列表",
    loadingSkillList: "正在加载技能列表...",
    installedSkillsEmpty: "当前未发现已安装 skill。",
    skillSourceWorkspace: "工作区技能",
    skillSourceManaged: "托管技能",
    skillSourceBundled: "内置技能",
    skillEnabled: "已启用",
    skillDisabled: "已停用",
    disableSkill: "停用技能",
    enableSkill: "启用技能",
    deleteSkill: "删除技能",
    skillManagementBackAriaLabel: "返回技能管理",
    removeSkillTitle: "删除技能",
    removeWorkspaceSkillConfirm: (slug) =>
      `确认删除工作区技能 \`${slug}\` 吗？`,
    removing: "删除中...",
    confirmDelete: "确认删除",
    languages: [
      { code: "en", label: "English" },
      { code: "zh-CN", label: "中文" },
    ],
  },
};

export default function App() {
  const [screen, setScreen] = useState<Screen>("language");
  const [preferences, setPreferences] = useState<LauncherPreferences | null>(
    null,
  );
  const [setupInfo, setSetupInfo] = useState<SetupInfo | null>(null);
  const [gatewayStatus, setGatewayStatus] = useState<GatewayStatus | null>(
    null,
  );
  const [ollamaStatus, setOllamaStatus] = useState<OllamaStatus | null>(null);
  const [configuredLocalModelExists, setConfiguredLocalModelExists] = useState<
    boolean | null
  >(null);
  const [selectedLanguage, setSelectedLanguage] =
    useState<LauncherLanguage>("en");
  const [isSaving, setIsSaving] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [hasCompletedLaunchSplashDelay, setHasCompletedLaunchSplashDelay] =
    useState(false);
  const [isStartingGateway, setIsStartingGateway] = useState(false);
  const [isStoppingGateway, setIsStoppingGateway] = useState(false);
  const [isResettingOpenClaw, setIsResettingOpenClaw] = useState(false);
  const [isOpeningSetup, setIsOpeningSetup] = useState(false);
  const [isOpeningTerminal, setIsOpeningTerminal] = useState(false);
  const [isOpeningConfigFile, setIsOpeningConfigFile] = useState(false);
  const [isStartingOllama, setIsStartingOllama] = useState(false);
  const [isStoppingOllama, setIsStoppingOllama] = useState(false);
  const [statusMessage, setStatusMessage] = useState("");
  const [modelToPull, setModelToPull] = useState<string>("");
  const [isModelListLoading, setIsModelListLoading] = useState(false);
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [pickerModelDraft, setPickerModelDraft] = useState<string>("");
  const [isAddingModelInPicker, setIsAddingModelInPicker] = useState(false);
  const [isValidatingPickerModelName, setIsValidatingPickerModelName] =
    useState(false);
  const [pickerValidationMessage, setPickerValidationMessage] = useState("");
  const [wantsLocalModel, setWantsLocalModel] = useState<boolean | null>(null);
  const [wantsCloudModel, setWantsCloudModel] = useState<boolean | null>(null);
  const [localModelName, setLocalModelName] = useState<string>("");
  const [cloudBaseUrl, setCloudBaseUrl] = useState<string>("");
  const [cloudApiKey, setCloudApiKey] = useState<string>("");
  const [cloudModelName, setCloudModelName] = useState<string>("");
  const [isValidatingLocalModelName, setIsValidatingLocalModelName] =
    useState(false);
  const [modelStepMessage, setModelStepMessage] = useState("");
  const [selectedChannel, setSelectedChannel] =
    useState<InitialChannelSelection>("weixin");
  const [qqAppId, setQqAppId] = useState("");
  const [qqAppSecret, setQqAppSecret] = useState("");
  const [isApplyingInitialSetup, setIsApplyingInitialSetup] = useState(false);
  const [isStartingWeixinLogin, setIsStartingWeixinLogin] = useState(false);
  const [isWaitingForWeixinLogin, setIsWaitingForWeixinLogin] = useState(false);
  const [weixinQrImageSrc, setWeixinQrImageSrc] = useState<string | null>(null);
  const [weixinLoginMessage, setWeixinLoginMessage] = useState("");
  const [localModelRunProgress, setLocalModelRunProgress] =
    useState<LocalModelRunProgress | null>(null);
  const [isChannelListLoading, setIsChannelListLoading] = useState(false);
  const [channelAccounts, setChannelAccounts] = useState<ChannelAccount[]>([]);
  const [isOpeningChannelWizard, setIsOpeningChannelWizard] = useState(false);
  const [removingChannelKey, setRemovingChannelKey] = useState<string | null>(
    null,
  );
  const [isModelCatalogLoading, setIsModelCatalogLoading] = useState(false);
  const [openclawModels, setOpenclawModels] = useState<ModelCatalogEntry[]>([]);
  const [isSkillListLoading, setIsSkillListLoading] = useState(false);
  const [installedSkills, setInstalledSkills] = useState<InstalledSkillEntry[]>(
    [],
  );
  const [collapsedSkillSources, setCollapsedSkillSources] = useState<
    Record<string, boolean>
  >({
    workspace: false,
    bundled: false,
    managed: true,
  });
  const [togglingSkillKey, setTogglingSkillKey] = useState<string | null>(null);
  const [isOpeningClawhubMarketplace, setIsOpeningClawhubMarketplace] =
    useState(false);
  const [removingWorkspaceSkillSlug, setRemovingWorkspaceSkillSlug] = useState<
    string | null
  >(null);
  const [pendingWorkspaceSkillRemoval, setPendingWorkspaceSkillRemoval] =
    useState<string | null>(null);
  const [isLogsLoading, setIsLogsLoading] = useState(false);
  const [selectedLogSource, setSelectedLogSource] =
    useState<LogSource>("launcher");
  const [launcherLogs, setLauncherLogs] = useState("");
  const [isOpeningModelProviderWizard, setIsOpeningModelProviderWizard] =
    useState(false);
  const [switchingModelKey, setSwitchingModelKey] = useState<string | null>(
    null,
  );
  const [isSavingLocalModelSelection, setIsSavingLocalModelSelection] =
    useState(false);
  const [mainNav, setMainNav] = useState<MainNav>("overview");
  const [configPage, setConfigPage] = useState<ConfigPage | null>(null);
  const [pendingLocalModelSelection, setPendingLocalModelSelection] =
    useState("");
  const [pendingOpenClawModelSelection, setPendingOpenClawModelSelection] =
    useState("");
  const [pendingLocalDownloadModel, setPendingLocalDownloadModel] =
    useState("");
  const [localModelPageDraft, setLocalModelPageDraft] =
    useState<LocalModelPageDraft | null>(null);
  const [localModelToggleDraftEnabled, setLocalModelToggleDraftEnabled] =
    useState(false);
  const [isStoppingLocalDownload, setIsStoppingLocalDownload] = useState(false);
  const [isStopLocalDownloadConfirmOpen, setIsStopLocalDownloadConfirmOpen] =
    useState(false);
  const [isResetConfirmOpen, setIsResetConfirmOpen] = useState(false);
  const [isSetupConfirmOpen, setIsSetupConfirmOpen] = useState(false);
  const [isChannelAddConfirmOpen, setIsChannelAddConfirmOpen] = useState(false);
  const [isModelProviderAddConfirmOpen, setIsModelProviderAddConfirmOpen] =
    useState(false);
  const [isLanguageSheetOpen, setIsLanguageSheetOpen] = useState(false);
  const [isMoreMenuOpen, setIsMoreMenuOpen] = useState(false);
  const [pendingLocalModelToggleAction, setPendingLocalModelToggleAction] =
    useState<LocalModelToggleAction | null>(null);
  const [systemMemoryInfo, setSystemMemoryInfo] =
    useState<SystemMemoryInfo | null>(null);
  const [memoryInfoFailed, setMemoryInfoFailed] = useState(false);
  const [appVersion, setAppVersion] = useState<string | null>(null);
  const [openclawVersion, setOpenclawVersion] = useState<string | null>(null);

  const appendFrontendStatusLog = (
    level: StatusLogLevel,
    message: string,
    context: StatusLogContext = {},
  ) => {
    void invoke("append_frontend_log", {
      level,
      message,
      context: {
        ...context,
        screen,
        mainNav,
        configPage,
        selectedLanguage,
        selectedLogSource,
        gatewayRunning: gatewayStatus?.running ?? null,
        ollamaRunning: ollamaStatus?.running ?? null,
      },
    }).catch(() => {
      // Ignore frontend logging failures to avoid blocking the UI.
    });
  };

  const showStatusMessage = (
    message: string,
    context: StatusLogContext = {},
    level: StatusLogLevel = "INFO",
  ) => {
    setStatusMessage(message);
    appendFrontendStatusLog(level, message, context);
  };

  const showStatusError = (
    error: unknown,
    fallback: string,
    context: StatusLogContext = {},
  ) => {
    const message = describeError(error, fallback);
    showStatusMessage(
      message,
      {
        ...context,
        fallback,
        error: serializeErrorForLog(error),
      },
      "ERROR",
    );
  };

  const clearStatusMessage = (context: StatusLogContext = {}) => {
    setStatusMessage("");
    appendFrontendStatusLog("INFO", "statusMessage cleared", context);
  };

  const contentScrollContainerRef = useRef<HTMLElement | null>(null);
  const logsContainerRef = useRef<HTMLPreElement | null>(null);
  const shouldStickLogsToBottomRef = useRef(true);

  const copy = copyByLanguage[selectedLanguage];
  const supportsLocalModels = setupInfo?.supportsLocalModels ?? false;
  const consoleVersionLabel = `${copy.consoleVersionName} v${appVersion ?? "..."}`;
  const configured = setupInfo?.configured ?? false;
  const isReady = gatewayStatus?.running ?? false;
  const isOllamaReady = ollamaStatus?.running ?? false;
  const openClawStatusLabel = isStartingGateway
    ? copy.startingGateway
    : isStoppingGateway
      ? copy.stoppingGateway
      : isReady
        ? copy.ollamaRunning
        : copy.pending;
  const localModelStatusLabel = isStartingOllama
    ? copy.startingOllama
    : isStoppingOllama
      ? copy.stoppingOllama
      : isOllamaReady
        ? copy.ollamaRunning
        : copy.ollamaOffline;
  const configuredCurrentModelRef = setupInfo?.currentModelRef.trim() ?? "";
  const configuredCurrentModelName = setupInfo?.currentModelName.trim() ?? "";
  const configuredCurrentModelProvider =
    setupInfo?.currentModelProvider.trim() ?? "";
  const configuredCurrentModelIsLocal = setupInfo?.currentModelIsLocal ?? false;
  const hasConfiguredCurrentModel =
    configuredCurrentModelRef.length > 0 ||
    configuredCurrentModelName.length > 0 ||
    configuredCurrentModelProvider.length > 0;
  const configuredCurrentModelRequiresExistingLocalModel =
    configuredCurrentModelIsLocal ||
    configuredCurrentModelProvider === "ollama";
  const isLocalModelEnabled =
    configuredCurrentModelIsLocal ||
    configuredCurrentModelProvider === "ollama";
  const isLocalModelToggleOn =
    isLocalModelEnabled || localModelToggleDraftEnabled;
  const canManageLocalModels = isLocalModelToggleOn;
  const shouldShowLocalModelOverviewCard =
    isOllamaReady || configuredCurrentModelProvider === "ollama";
  const configuredLocalModelName = configuredCurrentModelIsLocal
    ? configuredCurrentModelName
    : "";
  const activeModelName =
    configuredLocalModelName ||
    modelToPull.trim() ||
    localModelName.trim() ||
    FALLBACK_LOCAL_MODEL_NAME;
  const currentModelDisplayName = configuredCurrentModelIsLocal
    ? configuredCurrentModelName || copy.currentModelUnconfigured
    : configuredCurrentModelRef || copy.currentModelUnconfigured;
  const localModelOverviewDisplayName = hasConfiguredCurrentModel
    ? configuredCurrentModelIsLocal
      ? currentModelDisplayName
      : copy.currentModelNonLocalSummary
    : copy.currentModelUnconfigured;
  const openClawOverviewDisplayName = hasConfiguredCurrentModel
    ? configuredCurrentModelIsLocal
      ? copy.currentModelLocalSummary
      : currentModelDisplayName
    : copy.currentModelUnconfigured;
  const hasPendingLocalDownload = pendingLocalDownloadModel.trim().length > 0;
  const isBackgroundDownloadRunning = Boolean(
    localModelRunProgress?.running && localModelRunProgress.downloading,
  );
  const shouldShowLocalDownloadProgress =
    isBackgroundDownloadRunning || hasPendingLocalDownload;
  useEffect(() => {
    if (!supportsLocalModels && selectedLogSource === "ollama") {
      setSelectedLogSource("launcher");
    }
    if (!supportsLocalModels && configPage === "local-model") {
      setConfigPage(null);
    }
  }, [configPage, selectedLogSource, supportsLocalModels]);
  const gatewayStateInput = {
    configured,
    isStartingGateway,
    isStoppingGateway,
    isResettingOpenClaw,
    configuredCurrentModelRequiresExistingLocalModel,
    configuredCurrentModelName,
    configuredLocalModelExists,
    localModelRunProgress,
  };
  const gatewayStartState = getGatewayStartState(gatewayStateInput);
  const gatewayStatusCardState = getGatewayStatusCardState();
  const openClawModelsByProvider = useMemo(() => {
    const grouped = new Map<string, ModelCatalogEntry[]>();
    for (const entry of openclawModels) {
      const existing = grouped.get(entry.provider);
      if (existing) {
        existing.push(entry);
      } else {
        grouped.set(entry.provider, [entry]);
      }
    }
    return Array.from(grouped.entries());
  }, [openclawModels]);
  const currentOpenClawModel =
    openclawModels.find((entry) => entry.isCurrent) ?? null;
  const installedSkillsBySource = useMemo(() => {
    const grouped = new Map<string, InstalledSkillEntry[]>();
    for (const entry of installedSkills) {
      const existing = grouped.get(entry.source);
      if (existing) {
        existing.push(entry);
      } else {
        grouped.set(entry.source, [entry]);
      }
    }
    const sourceOrder = new Map([
      ["workspace", 0],
      ["bundled", 1],
      ["managed", 2],
    ]);
    return Array.from(grouped.entries()).sort(
      ([left], [right]) =>
        (sourceOrder.get(left) ?? 99) - (sourceOrder.get(right) ?? 99),
    );
  }, [installedSkills]);
  const visibleLocalModels = useMemo(() => {
    const hiddenDownloadingModel = shouldShowLocalDownloadProgress
      ? localModelRunProgress?.model.trim() || pendingLocalDownloadModel.trim()
      : "";

    return filterVisibleLocalModels(availableModels, hiddenDownloadingModel);
  }, [
    availableModels,
    localModelRunProgress,
    pendingLocalDownloadModel,
    shouldShowLocalDownloadProgress,
  ]);
  const bytesPerGiB = 1024 * 1024 * 1024;
  const relevantMemoryBytes =
    systemMemoryInfo === null
      ? null
      : systemMemoryInfo.gpuTotalBytes && systemMemoryInfo.gpuTotalBytes > 0
        ? systemMemoryInfo.gpuTotalBytes
        : systemMemoryInfo.totalRamBytes;
  const recommendedModelLimitGiB =
    relevantMemoryBytes !== null
      ? Math.max(
          1,
          Math.floor((relevantMemoryBytes / bytesPerGiB) * 0.5 * 10) / 10,
        )
      : null;
  const defaultRecommendedLocalModelName = getRecommendedLocalModelName(
    recommendedModelLimitGiB,
  );
  const hasResolvedRecommendedLocalModel =
    recommendedModelLimitGiB !== null || memoryInfoFailed;
  const resolvedDefaultLocalModelName = hasResolvedRecommendedLocalModel
    ? defaultRecommendedLocalModelName
    : "";
  const localModelPlaceholder = defaultRecommendedLocalModelName;
  const recommendedModelLimitLabel =
    recommendedModelLimitGiB !== null
      ? recommendedModelLimitGiB.toFixed(1)
      : null;
  const renderMemoryHint = () => {
    if (systemMemoryInfo) {
      const ramDisplay = formatBytes(systemMemoryInfo.totalRamBytes);
      const gpuDisplay =
        systemMemoryInfo.gpuTotalBytes && systemMemoryInfo.gpuTotalBytes > 0
          ? ` · ${formatBytes(systemMemoryInfo.gpuTotalBytes)} ${copy.memoryGpuLabel}`
          : "";
      return (
        <div className="mt-3 text-xs text-slate-500">
          <p className="text-xs">
            {copy.memoryInfoTitle}:{" "}
            <span className="font-medium text-slate-900">
              {ramDisplay} {copy.memoryRamLabel}
              {gpuDisplay}
            </span>
          </p>
          {recommendedModelLimitLabel ? (
            <p>
              {copy.memoryModelLimit}{" "}
              <span className="font-semibold text-slate-900">
                {recommendedModelLimitLabel} GB
              </span>
            </p>
          ) : null}
        </div>
      );
    }

    if (memoryInfoFailed) {
      return (
        <p className="mt-3 text-xs text-slate-500">
          {copy.memoryInfoUnavailable}
        </p>
      );
    }

    return (
      <p className="mt-3 text-xs text-slate-500">{copy.memoryInfoDetecting}</p>
    );
  };

  const refreshMainState = async (
    language: LauncherLanguage,
    progressOverride: LocalModelRunProgress | null = localModelRunProgress,
  ) => {
    const [nextSetupInfo, nextGatewayStatus] = await Promise.all([
      invoke<SetupInfo>("read_setup_info"),
      invoke<GatewayStatus>("gateway_status"),
    ]);
    const nextOllamaStatus = nextSetupInfo.supportsLocalModels
      ? await invoke<OllamaStatus>("ollama_status")
      : null;

    setSetupInfo(nextSetupInfo);
    setGatewayStatus(nextGatewayStatus);
    setOllamaStatus(nextOllamaStatus);
    if (
      nextSetupInfo.currentModelIsLocal &&
      nextSetupInfo.currentModelName.trim().length > 0
    ) {
      setModelToPull(nextSetupInfo.currentModelName);
      setLocalModelName(nextSetupInfo.currentModelName);
    }
    let nextConfiguredLocalModelExists: boolean | null = null;
    const nextLocalModelName = nextSetupInfo.currentModelName.trim();
    const nextRequiresExistingLocalModel =
      nextSetupInfo.supportsLocalModels &&
      (nextSetupInfo.currentModelIsLocal ||
        nextSetupInfo.currentModelProvider.trim() === "ollama");

    if (nextRequiresExistingLocalModel && nextLocalModelName.length > 0) {
      try {
        nextConfiguredLocalModelExists = await invoke<boolean>(
          "check_local_model_exists",
          {
            model: nextLocalModelName,
          },
        );
      } catch {
        nextConfiguredLocalModelExists = null;
      }
    }

    setConfiguredLocalModelExists(nextConfiguredLocalModelExists);
    if (!nextSetupInfo.configured) {
      showStatusMessage(copyByLanguage[language].statusSetupRequired, {
        action: "refreshMainState",
        reason: "setup_not_configured",
      });
      return;
    }
    if (
      isDownloadingRequiredLocalModel(
        nextRequiresExistingLocalModel,
        nextLocalModelName,
        nextConfiguredLocalModelExists,
        progressOverride,
      )
    ) {
      showStatusMessage(
        copyByLanguage[language].statusStartGatewayWaitForModelDownload(
          nextLocalModelName,
        ),
        {
          action: "refreshMainState",
          reason: "configured_local_model_downloading",
          localModelName: nextLocalModelName,
        },
        "INFO",
      );
      return;
    }
    if (
      nextRequiresExistingLocalModel &&
      !isRequiredLocalModelAvailableForGateway({
        configuredCurrentModelRequiresExistingLocalModel:
          nextRequiresExistingLocalModel,
        configuredCurrentModelName: nextLocalModelName,
        configuredLocalModelExists: nextConfiguredLocalModelExists,
        localModelRunProgress: progressOverride,
      })
    ) {
      showStatusMessage(
        copyByLanguage[language].statusStartGatewayRequiresLocalModel,
        {
          action: "refreshMainState",
          reason: "configured_local_model_missing",
          localModelName: nextLocalModelName,
        },
        "WARN",
      );
      return;
    }
    clearStatusMessage({
      action: "refreshMainState",
      reason: "status_healthy",
    });
  };

  useEffect(() => {
    const splashDelayTimer = window.setTimeout(() => {
      setHasCompletedLaunchSplashDelay(true);
    }, MIN_LAUNCH_SPLASH_MS);

    void (async () => {
      setIsLoading(true);
      try {
        const [nextPreferences, nextSetupInfo] = await Promise.all([
          invoke<LauncherPreferences>("read_launcher_preferences"),
          invoke<SetupInfo>("read_setup_info"),
        ]);
        setPreferences(nextPreferences);
        setSelectedLanguage(nextPreferences.language);
        setSetupInfo(nextSetupInfo);

        if (nextPreferences.isInitialized) {
          await refreshMainState(nextPreferences.language);
          setScreen("main");
        } else {
          setScreen("language");
          clearStatusMessage({
            action: "initialLoad",
            reason: "show_language_screen",
          });
        }
      } catch (error) {
        showStatusError(error, copyByLanguage.en.loadFailed, {
          action: "initialLoad",
          command: "read_launcher_preferences",
        });
      } finally {
        setIsLoading(false);
      }
    })();

    return () => {
      window.clearTimeout(splashDelayTimer);
    };
  }, []);

  const shouldShowLaunchSplash = isLoading || !hasCompletedLaunchSplashDelay;

  useEffect(() => {
    void (async () => {
      try {
        const version = await getVersion();
        setAppVersion(version);
      } catch {
        setAppVersion(null);
      }
    })();
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const version = await invoke<string>(
          "read_bundled_openclaw_version_command",
        );
        setOpenclawVersion(version);
      } catch {
        setOpenclawVersion(null);
      }
    })();
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const info = await invoke<SystemMemoryInfo>("get_system_memory_info");
        setSystemMemoryInfo(info);
      } catch {
        setMemoryInfoFailed(true);
      }
    })();
  }, []);

  const hasInitializedRecommendedLocalModelRef = useRef(false);

  useEffect(() => {
    if (hasInitializedRecommendedLocalModelRef.current) return;
    if (!hasResolvedRecommendedLocalModel) return;

    setModelToPull((currentValue) =>
      currentValue.trim().length === 0
        ? defaultRecommendedLocalModelName
        : currentValue,
    );
    setLocalModelName((currentValue) =>
      currentValue.trim().length === 0
        ? defaultRecommendedLocalModelName
        : currentValue,
    );
    setPickerModelDraft((currentValue) =>
      currentValue.trim().length === 0
        ? defaultRecommendedLocalModelName
        : currentValue,
    );

    hasInitializedRecommendedLocalModelRef.current = true;
  }, [defaultRecommendedLocalModelName, hasResolvedRecommendedLocalModel]);

  const previousLocalModelRunProgressRef = useRef<LocalModelRunProgress | null>(
    null,
  );

  useEffect(() => {
    if (screen !== "main") return;

    let cancelled = false;
    const loadProgress = async () => {
      try {
        const progress = await invoke<LocalModelRunProgress>(
          "get_local_model_run_progress",
        );
        if (cancelled) return;
        const previousProgress = previousLocalModelRunProgressRef.current;
        setLocalModelRunProgress(progress);
        previousLocalModelRunProgressRef.current = progress;
        if (
          shouldRefreshAfterLocalModelDownload({
            previousProgress,
            nextProgress: progress,
            configuredCurrentModelRequiresExistingLocalModel,
            configuredCurrentModelName,
          })
        ) {
          setConfiguredLocalModelExists(true);
          void refreshMainState(selectedLanguage, progress);
        }
        if (
          isDownloadingRequiredLocalModel(
            configuredCurrentModelRequiresExistingLocalModel,
            configuredCurrentModelName,
            configuredLocalModelExists,
            progress,
          )
        ) {
          showStatusMessage(
            copyByLanguage[
              selectedLanguage
            ].statusStartGatewayWaitForModelDownload(
              configuredCurrentModelName || progress.model,
            ),
            {
              action: "pollLocalModelRunProgress",
              reason: "configured_local_model_downloading",
              progress,
            },
            "INFO",
          );
          return;
        }
        if (!progress.running && progress.message.trim().length > 0) {
          showStatusMessage(progress.message, {
            action: "pollLocalModelRunProgress",
            progress,
          });
        }
      } catch {
        // Ignore transient polling failures.
      }
    };

    void loadProgress();
    const timer = window.setInterval(() => {
      void loadProgress();
    }, 900);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [
    configuredCurrentModelName,
    configuredCurrentModelRequiresExistingLocalModel,
    configuredLocalModelExists,
    screen,
    selectedLanguage,
  ]);

  useEffect(() => {
    if (screen !== "main" || mainNav !== "overview") return;

    void refreshMainState(selectedLanguage);
  }, [mainNav, screen, selectedLanguage]);

  useEffect(() => {
    setIsMoreMenuOpen(false);
  }, [mainNav, screen]);

  useEffect(() => {
    if (screen !== "main" || mainNav !== "logs") return;

    void loadLauncherLogs(selectedLogSource);

    const timer = window.setInterval(() => {
      void loadLauncherLogs(selectedLogSource, { silent: true });
    }, 2000);

    return () => {
      window.clearInterval(timer);
    };
  }, [mainNav, screen, selectedLogSource]);

  useEffect(() => {
    syncLogsScrollPosition();
  }, [launcherLogs]);

  const handleSelectLanguage = async (language: LauncherLanguage) => {
    setSelectedLanguage(language);
    clearStatusMessage({ action: "handleSelectLanguage", language });
    if (!preferences) return;

    setIsSaving(true);
    try {
      const nextPreferences = await invoke<LauncherPreferences>(
        "save_launcher_preferences",
        {
          language,
          installDir: preferences.installDir,
          isInitialized: false,
          isInitializationInProgress: true,
        },
      );
      setPreferences(nextPreferences);
      setSelectedLanguage(nextPreferences.language);
      setScreen("model");
    } catch (error) {
      showStatusError(error, copyByLanguage[language].saveFailed, {
        action: "handleSelectLanguage",
        language,
        installDir: preferences.installDir,
      });
    } finally {
      setIsSaving(false);
    }
  };

  const handleChangeLanguageFromSheet = async (language: LauncherLanguage) => {
    setSelectedLanguage(language);
    clearStatusMessage({ action: "handleChangeLanguageFromSheet", language });
    if (!preferences) return;

    setIsSaving(true);
    try {
      const nextPreferences = await invoke<LauncherPreferences>(
        "save_launcher_preferences",
        {
          language,
          installDir: preferences.installDir,
          isInitialized: preferences.isInitialized,
          isInitializationInProgress: preferences.isInitializationInProgress,
        },
      );
      setPreferences(nextPreferences);
      setSelectedLanguage(nextPreferences.language);
      setIsLanguageSheetOpen(false);
      if (screen === "main") {
        await refreshMainState(nextPreferences.language);
      }
    } catch (error) {
      showStatusError(error, copyByLanguage[language].saveFailed, {
        action: "handleChangeLanguageFromSheet",
        language,
        installDir: preferences.installDir,
        isInitialized: preferences.isInitialized,
      });
    } finally {
      setIsSaving(false);
    }
  };

  const startInitializationFlow = async () => {
    clearStatusMessage({ action: "startInitializationFlow" });
    setModelStepMessage("");
    setWantsLocalModel(null);
    setLocalModelName(resolvedDefaultLocalModelName);
    setModelToPull(resolvedDefaultLocalModelName);
    setSelectedChannel("weixin");
    setWeixinQrImageSrc(null);
    setWeixinLoginMessage("");
    setQqAppId("");
    setQqAppSecret("");
    setMainNav("overview");
    setConfigPage(null);
    if (preferences?.hasSavedPreferences) {
      try {
        const nextPreferences = await invoke<LauncherPreferences>(
          "save_launcher_preferences",
          {
            language: preferences.language,
            installDir: preferences.installDir,
            isInitialized: false,
            isInitializationInProgress: true,
          },
        );
        setPreferences(nextPreferences);
        setSelectedLanguage(nextPreferences.language);
      } catch (error) {
        showStatusError(error, copy.saveFailed, {
          action: "startInitializationFlow",
          command: "save_launcher_preferences",
        });
        return;
      }
    }
    setScreen("language");
  };

  const handleContinueModelStep = async () => {
    if (!supportsLocalModels) {
      if (wantsCloudModel === null) return;
      if (!wantsCloudModel) {
        setModelStepMessage("");
        setSelectedChannel("weixin");
        setWeixinQrImageSrc(null);
        setWeixinLoginMessage("");
        clearStatusMessage({
          action: "handleContinueModelStep",
          nextScreen: "channel",
          mode: "cloud_skip",
        });
        setScreen("channel");
        return;
      }
      const normalizedBaseUrl = cloudBaseUrl.trim();
      const normalizedApiKey = cloudApiKey.trim();
      const normalizedCloudModelName = cloudModelName.trim();
      if (normalizedBaseUrl.length === 0) {
        setModelStepMessage(copy.cloudBaseUrlValidationEmpty);
        return;
      }
      try {
        const parsedUrl = new URL(normalizedBaseUrl);
        if (!["http:", "https:"].includes(parsedUrl.protocol)) {
          setModelStepMessage(copy.cloudBaseUrlInvalid);
          return;
        }
      } catch {
        setModelStepMessage(copy.cloudBaseUrlInvalid);
        return;
      }
      if (normalizedApiKey.length === 0) {
        setModelStepMessage(copy.cloudApiKeyValidationEmpty);
        return;
      }
      if (normalizedCloudModelName.length === 0) {
        setModelStepMessage(copy.cloudModelValidationEmpty);
        return;
      }

      setModelStepMessage("");
      setSelectedChannel("weixin");
      setWeixinQrImageSrc(null);
      setWeixinLoginMessage("");
      clearStatusMessage({
        action: "handleContinueModelStep",
        nextScreen: "channel",
        mode: "cloud",
      });
      setScreen("channel");
      return;
    }

    if (wantsLocalModel === null) return;
    if (wantsLocalModel) {
      const normalizedModelName = localModelName.trim();
      if (normalizedModelName.length === 0) {
        setModelStepMessage(copy.modelNameValidationEmpty);
        return;
      }
      if (looksLikeCloudModelName(normalizedModelName)) {
        setModelStepMessage(copy.modelNameCloudHint);
        return;
      }
      setIsValidatingLocalModelName(true);
      setModelStepMessage(copy.validatingModel);
      try {
        await invoke("start_local_model_run", { model: normalizedModelName });
        const validation =
          await waitForLocalModelValidation(normalizedModelName);
        if (!validation.ready) {
          setModelStepMessage(validation.reason ?? copy.modelNameInvalid);
          return;
        }
      } catch (error) {
        if (!isLocalModelRunAlreadyInProgressError(error)) {
          setModelStepMessage(describeError(error, copy.modelNameInvalid));
          return;
        }
        const validation =
          await waitForLocalModelValidation(normalizedModelName);
        if (!validation.ready) {
          setModelStepMessage(
            validation.reason ?? describeError(error, copy.modelNameInvalid),
          );
          return;
        }
      } finally {
        setIsValidatingLocalModelName(false);
      }
      setModelToPull(normalizedModelName);
    }

    setModelStepMessage("");
    setSelectedChannel("weixin");
    setWeixinQrImageSrc(null);
    setWeixinLoginMessage("");
    clearStatusMessage({
      action: "handleContinueModelStep",
      nextScreen: "channel",
    });
    setScreen("channel");
  };

  const handleContinueChannelStep = async () => {
    if (isApplyingInitialSetup) return;
    if (
      selectedChannel === "qq" &&
      (qqAppId.trim().length === 0 || qqAppSecret.trim().length === 0)
    ) {
      return;
    }

    const request: InitialSetupConfigRequest = {};
    if (supportsLocalModels && wantsLocalModel) {
      request.localModel = localModelName.trim();
    }
    if (!supportsLocalModels && wantsCloudModel) {
      request.cloudModel = {
        baseUrl: cloudBaseUrl.trim(),
        apiKey: cloudApiKey.trim(),
        model: cloudModelName.trim(),
      };
    }
    request.channelSelection = selectedChannel;
    if (selectedChannel === "qq") {
      request.qq = {
        appId: qqAppId.trim(),
        appSecret: qqAppSecret.trim(),
      };
    }

    if (selectedChannel === "weixin") {
      setWeixinQrImageSrc(null);
      setWeixinLoginMessage("");
    }

    setIsApplyingInitialSetup(selectedChannel !== "weixin");
    try {
      await invoke("apply_initial_setup_config", { request });
    } catch (error) {
      setIsApplyingInitialSetup(false);
      showStatusError(error, copy.applyInitialSetupFailed, {
        action: "handleContinueChannelStep",
        request,
      });
      return;
    }

    if (selectedChannel === "weixin") {
      setIsStartingWeixinLogin(true);
      try {
        const startResult = await invoke<StartWeixinLoginResult>(
          "start_initial_weixin_login",
        );
        setWeixinQrImageSrc(
          startResult.qrDataUrl
            ? await toRenderableWeixinQrSrc(startResult.qrDataUrl)
            : null,
        );
        setWeixinLoginMessage(startResult.message);
        setIsStartingWeixinLogin(false);
        setIsWaitingForWeixinLogin(true);

        const waitResult = await invoke<WaitWeixinLoginResult>(
          "wait_for_initial_weixin_login",
          {
            sessionKey: startResult.sessionKey,
          },
        );

        setIsWaitingForWeixinLogin(false);
        setWeixinLoginMessage(waitResult.message);
        if (!waitResult.connected) {
          return;
        }
      } catch (error) {
        setIsStartingWeixinLogin(false);
        setIsWaitingForWeixinLogin(false);
        showStatusError(error, copy.weixinLoginFailed, {
          action: "handleContinueChannelStep",
          channel: selectedChannel,
        });
        return;
      }
    }

    if (preferences) {
      setPreferences({
        ...preferences,
        isInitialized: true,
        isInitializationInProgress: false,
        hasSavedPreferences: true,
      });
    }

    try {
      await refreshMainState(selectedLanguage);
      setScreen("main");
    } catch (error) {
      showStatusError(error, copy.pullModelFailed, {
        action: "handleContinueChannelStep",
        phase: "refreshMainState",
      });
    } finally {
      setIsApplyingInitialSetup(false);
      setIsStartingWeixinLogin(false);
      setIsWaitingForWeixinLogin(false);
    }
  };

  const handleOpenQqOpenPlatform = async () => {
    try {
      await invoke("open_external_url", {
        url: "https://q.qq.com/qqbot/openclaw/",
      });
    } catch (error) {
      showStatusError(error, copy.openUiFailed, {
        action: "handleOpenQqOpenPlatform",
        url: "https://q.qq.com/qqbot/openclaw/",
      });
    }
  };

  const waitForLocalModelValidation = async (
    targetModel: string,
  ): Promise<LocalModelValidationResult> => {
    const normalizedTargetModel = targetModel.trim();
    const deadline = Date.now() + 120000;
    let lastTargetMessage = "";
    let lastObservedModel = "";

    while (Date.now() < deadline) {
      const progress = await invoke<LocalModelRunProgress>(
        "get_local_model_run_progress",
      );

      const normalizedMessage = progress.message.trim();
      const normalizedProgressModel = progress.model.trim();
      if (normalizedProgressModel.length > 0) {
        lastObservedModel = normalizedProgressModel;
      }
      const isTargetModelProgress =
        normalizedProgressModel.length > 0 &&
        normalizedProgressModel === normalizedTargetModel;

      if (isTargetModelProgress && normalizedMessage.length > 0) {
        lastTargetMessage = normalizedMessage;
      }

      if (progress.error?.trim() && isTargetModelProgress) {
        return { ready: false, reason: progress.error.trim() };
      }

      if (isTargetModelProgress && progress.success) {
        return { ready: true, reason: null };
      }

      if (isTargetModelProgress && progress.hasKnownProgress) {
        return { ready: true, reason: null };
      }

      if (
        isTargetModelProgress &&
        progress.completedBytes !== null &&
        progress.totalBytes !== null &&
        progress.totalBytes > 0
      ) {
        return { ready: true, reason: null };
      }

      if (
        progress.running &&
        !isTargetModelProgress &&
        normalizedProgressModel.length > 0
      ) {
        return {
          ready: false,
          reason: `a local model run task is already in progress (${normalizedProgressModel})`,
        };
      }

      await new Promise((resolve) => window.setTimeout(resolve, 250));
    }

    return {
      ready: false,
      reason:
        lastTargetMessage.length > 0
          ? lastTargetMessage
          : lastObservedModel.length > 0 &&
              lastObservedModel !== normalizedTargetModel
            ? `a local model run task is already in progress (${lastObservedModel})`
            : `local model validation is still running for ${normalizedTargetModel}, please wait`,
    };
  };

  useEffect(() => {
    setModelStepMessage("");
  }, [localModelName, wantsLocalModel]);

  useEffect(() => {
    setPickerValidationMessage("");
  }, [pickerModelDraft, isAddingModelInPicker]);

  const handleOpenModelSearch = async () => {
    try {
      await invoke("open_external_url", { url: "https://ollama.com/search" });
    } catch (error) {
      showStatusError(error, copy.openUiFailed, {
        action: "handleOpenModelSearch",
        url: "https://ollama.com/search",
      });
    }
  };

  const handleOpenWhereClawWebsite = async () => {
    try {
      await invoke("open_external_url", { url: "https://whereclaw.com" });
    } catch (error) {
      showStatusError(error, copy.openUiFailed, {
        action: "handleOpenWhereClawWebsite",
        url: "https://whereclaw.com",
      });
    }
  };

  const handleOpenSetup = async () => {
    setIsOpeningSetup(true);
    try {
      await invoke("open_official_setup_wizard");
      setIsSetupConfirmOpen(false);
      await refreshMainState(selectedLanguage);
    } catch (error) {
      showStatusError(error, copy.setupFailed, {
        action: "handleOpenSetup",
      });
    } finally {
      setIsOpeningSetup(false);
    }
  };

  const handleOpenConfigFile = async () => {
    setIsOpeningConfigFile(true);
    try {
      await invoke("open_openclaw_config_file");
      setIsMoreMenuOpen(false);
    } catch (error) {
      showStatusError(error, copy.openConfigFileFailed, {
        action: "handleOpenConfigFile",
      });
    } finally {
      setIsOpeningConfigFile(false);
    }
  };

  const handleOpenWhereClawTerminal = async () => {
    setIsOpeningTerminal(true);
    try {
      await invoke("open_whereclaw_terminal");
      setIsMoreMenuOpen(false);
    } catch (error) {
      showStatusError(error, copy.openTerminalFailed, {
        action: "handleOpenWhereClawTerminal",
      });
    } finally {
      setIsOpeningTerminal(false);
    }
  };

  const handleCopyQqGroupNumber = async () => {
    try {
      await copyTextToClipboard(QQ_GROUP_NUMBER);
      setIsMoreMenuOpen(false);
      showStatusMessage(copy.qqGroupCopied, {
        action: "handleCopyQqGroupNumber",
        qqGroupNumber: QQ_GROUP_NUMBER,
      });
    } catch (error) {
      showStatusError(error, copy.qqGroupCopyFailed, {
        action: "handleCopyQqGroupNumber",
        qqGroupNumber: QQ_GROUP_NUMBER,
      });
    }
  };

  const syncLogsScrollPosition = () => {
    const element = logsContainerRef.current;
    if (!element || !shouldStickLogsToBottomRef.current) {
      return;
    }
    element.scrollTop = element.scrollHeight;
  };

  const loadLauncherLogs = async (
    source: LogSource = selectedLogSource,
    options?: { silent?: boolean },
  ) => {
    if (!options?.silent) {
      setIsLogsLoading(true);
    }
    try {
      const logs = await invoke<string>("read_launcher_logs", { source });
      setLauncherLogs(logs);
    } catch (error) {
      showStatusError(error, copy.loadFailed, {
        action: "loadLauncherLogs",
        source,
        silent: options?.silent ?? false,
      });
      setLauncherLogs("");
    } finally {
      if (!options?.silent) {
        setIsLogsLoading(false);
      }
    }
  };

  const loadChannelAccounts = async () => {
    setIsChannelListLoading(true);
    try {
      const nextAccounts = await invoke<ChannelAccount[]>(
        "list_channel_accounts",
      );
      setChannelAccounts(nextAccounts);
    } catch (error) {
      showStatusError(error, copy.listChannelsFailed, {
        action: "loadChannelAccounts",
      });
      setChannelAccounts([]);
    } finally {
      setIsChannelListLoading(false);
    }
  };

  const handleOpenChannelAddWizard = async () => {
    setIsOpeningChannelWizard(true);
    try {
      await invoke("open_channel_add_wizard");
      setIsChannelAddConfirmOpen(false);
      await loadChannelAccounts();
      await refreshMainState(selectedLanguage);
    } catch (error) {
      showStatusError(error, copy.openChannelWizardFailed, {
        action: "handleOpenChannelAddWizard",
      });
    } finally {
      setIsOpeningChannelWizard(false);
    }
  };

  const handleRemoveChannelAccount = async (
    channel: string,
    accountId: string,
  ) => {
    const key = `${channel}::${accountId}`;
    setRemovingChannelKey(key);
    try {
      await invoke("remove_channel_account", { channel, accountId });
      await loadChannelAccounts();
      await refreshMainState(selectedLanguage);
    } catch (error) {
      showStatusError(error, copy.removeChannelFailed, {
        action: "handleRemoveChannelAccount",
        channel,
        accountId,
      });
    } finally {
      setRemovingChannelKey(null);
    }
  };

  const loadOpenClawModels = async () => {
    setIsModelCatalogLoading(true);
    try {
      const entries = await invoke<ModelCatalogEntry[]>("list_openclaw_models");
      setOpenclawModels(entries);
    } catch (error) {
      showStatusError(error, copy.listOpenClawModelsFailed, {
        action: "loadOpenClawModels",
      });
      setOpenclawModels([]);
    } finally {
      setIsModelCatalogLoading(false);
    }
  };

  const loadInstalledSkills = async () => {
    setIsSkillListLoading(true);
    try {
      const entries = await invoke<InstalledSkillEntry[]>(
        "list_installed_skills",
      );
      setInstalledSkills(entries);
    } catch (error) {
      showStatusError(error, copy.loadInstalledSkillsFailed, {
        action: "loadInstalledSkills",
      });
      setInstalledSkills([]);
    } finally {
      setIsSkillListLoading(false);
    }
  };

  const handleToggleSkillEnabled = async (
    skillKey: string,
    nextEnabled: boolean,
  ) => {
    const normalizedSkillKey = skillKey.trim();
    if (normalizedSkillKey.length === 0) return;
    setTogglingSkillKey(normalizedSkillKey);
    try {
      await invoke("set_skill_enabled", {
        skillKey: normalizedSkillKey,
        enabled: nextEnabled,
      });
      await loadInstalledSkills();
    } catch (error) {
      showStatusError(error, copy.toggleSkillFailed, {
        action: "handleToggleSkillEnabled",
        skillKey: normalizedSkillKey,
        nextEnabled,
      });
    } finally {
      setTogglingSkillKey(null);
    }
  };

  const handleOpenClawhubMarketplace = async () => {
    setIsOpeningClawhubMarketplace(true);
    try {
      await invoke("open_clawhub_marketplace_window", {
        language: selectedLanguage,
      });
    } catch (error) {
      showStatusError(error, copy.openSkillCatalogFailed, {
        action: "handleOpenClawhubMarketplace",
      });
    } finally {
      setIsOpeningClawhubMarketplace(false);
    }
  };

  const handleRemoveWorkspaceSkill = async (slug: string) => {
    const normalizedSlug = slug.trim();
    if (normalizedSlug.length === 0) return;
    setRemovingWorkspaceSkillSlug(normalizedSlug);
    try {
      await invoke("remove_workspace_skill", { slug: normalizedSlug });
      await loadInstalledSkills();
      showStatusMessage(copy.removeSkillSuccess(normalizedSlug), {
        action: "handleRemoveWorkspaceSkill",
        slug: normalizedSlug,
      });
    } catch (error) {
      showStatusError(error, copy.removeSkillFailed, {
        action: "handleRemoveWorkspaceSkill",
        slug: normalizedSlug,
      });
    } finally {
      setRemovingWorkspaceSkillSlug(null);
    }
  };

  const handleConfirmRemoveWorkspaceSkill = async () => {
    if (!pendingWorkspaceSkillRemoval) return;
    const slug = pendingWorkspaceSkillRemoval;
    setPendingWorkspaceSkillRemoval(null);
    await handleRemoveWorkspaceSkill(slug);
  };

  const handleOpenModelProviderAddWizard = async () => {
    setIsOpeningModelProviderWizard(true);
    try {
      await invoke("open_model_provider_add_wizard");
      setIsModelProviderAddConfirmOpen(false);
      await loadOpenClawModels();
      await refreshMainState(selectedLanguage);
    } catch (error) {
      showStatusError(error, copy.openModelProviderWizardFailed, {
        action: "handleOpenModelProviderAddWizard",
      });
    } finally {
      setIsOpeningModelProviderWizard(false);
    }
  };

  const handleSwitchOpenClawModel = async (modelRef: string) => {
    const normalizedModelRef = modelRef.trim();
    if (normalizedModelRef.length === 0) return;
    const isCloudModelRef = !normalizedModelRef.startsWith("ollama/");
    setSwitchingModelKey(normalizedModelRef);
    try {
      await invoke("set_openclaw_primary_model", { model: normalizedModelRef });
      setModelToPull(normalizedModelRef);
      setLocalModelName(normalizedModelRef);
      if (isCloudModelRef && isOllamaReady) {
        await handleStopOllama();
      }
      await loadOpenClawModels();
      await refreshMainState(selectedLanguage);
    } catch (error) {
      showStatusError(error, copy.switchModelFailed, {
        action: "handleSwitchOpenClawModel",
        modelRef: normalizedModelRef,
        isCloudModelRef,
      });
    } finally {
      setSwitchingModelKey(null);
    }
  };

  const handleResetOpenClawConfig = async () => {
    setIsResettingOpenClaw(true);
    try {
      const nextSetupInfo = await invoke<SetupInfo>("reset_openclaw_config");
      setSetupInfo(nextSetupInfo);
      clearStatusMessage({ action: "handleResetOpenClawConfig" });
      setIsResetConfirmOpen(false);
      await startInitializationFlow();
    } catch (error) {
      showStatusError(error, copy.resetOpenClawFailed, {
        action: "handleResetOpenClawConfig",
      });
    } finally {
      setIsResettingOpenClaw(false);
    }
  };

  const handleStartGateway = async () => {
    if (configuredCurrentModelProvider === "ollama" && !isOllamaReady) {
      showStatusMessage(copy.statusStartGatewayRequiresOllama, {
        action: "handleStartGateway",
        reason: "ollama_not_ready",
        configuredCurrentModelProvider,
      });
      return;
    }
    if (gatewayStartState.showDownloadHint) {
      showStatusMessage(
        copy.statusStartGatewayWaitForModelDownload(configuredCurrentModelName),
        {
          action: "handleStartGateway",
          reason: "configured_local_model_downloading",
          configuredCurrentModelName,
        },
        "INFO",
      );
      return;
    }
    if (
      configuredCurrentModelRequiresExistingLocalModel &&
      !isRequiredLocalModelAvailableForGateway({
        configuredCurrentModelRequiresExistingLocalModel,
        configuredCurrentModelName,
        configuredLocalModelExists,
        localModelRunProgress,
      })
    ) {
      showStatusMessage(copy.statusStartGatewayRequiresLocalModel, {
        action: "handleStartGateway",
        reason: "configured_local_model_missing",
        configuredCurrentModelName,
      });
      return;
    }

    setIsStartingGateway(true);
    try {
      const nextGatewayStatus = await invoke<GatewayStatus>("start_gateway");
      setGatewayStatus(nextGatewayStatus);
      clearStatusMessage({ action: "handleStartGateway", result: "started" });
      void handleOpenControlUi();
    } catch (error) {
      showStatusError(error, copy.startFailed, {
        action: "handleStartGateway",
      });
    } finally {
      setIsStartingGateway(false);
    }
  };

  const handleStopGateway = async () => {
    setIsStoppingGateway(true);
    try {
      const nextGatewayStatus = await invoke<GatewayStatus>("stop_gateway");
      setGatewayStatus(nextGatewayStatus);
      if (configured) {
        clearStatusMessage({
          action: "handleStopGateway",
          result: "stopped",
          configured,
        });
      } else {
        showStatusMessage(copy.statusSetupRequired, {
          action: "handleStopGateway",
          result: "stopped",
          configured,
        });
      }
    } catch (error) {
      showStatusError(error, copy.stopFailed, {
        action: "handleStopGateway",
      });
    } finally {
      setIsStoppingGateway(false);
    }
  };

  const handleOpenControlUi = async () => {
    try {
      await invoke("open_control_ui_window");
    } catch (error) {
      showStatusError(error, copy.openUiFailed, {
        action: "handleOpenControlUi",
      });
    }
  };

  const handleStartOllama = async () => {
    setIsStartingOllama(true);
    clearStatusMessage({ action: "handleStartOllama" });
    try {
      const nextOllamaStatus = await invoke<OllamaStatus>("start_ollama");
      setOllamaStatus(nextOllamaStatus);
      return nextOllamaStatus;
    } catch (error) {
      showStatusError(error, copy.startOllamaFailed, {
        action: "handleStartOllama",
      });
      return null;
    } finally {
      setIsStartingOllama(false);
    }
  };

  const handleStopOllama = async () => {
    setIsStoppingOllama(true);
    try {
      const nextOllamaStatus = await invoke<OllamaStatus>("stop_ollama");
      setOllamaStatus(nextOllamaStatus);
    } catch (error) {
      showStatusError(error, copy.stopOllamaFailed, {
        action: "handleStopOllama",
      });
    } finally {
      try {
        const refreshedStatus = await invoke<OllamaStatus>("ollama_status");
        setOllamaStatus(refreshedStatus);
      } catch {
        // Ignore follow-up refresh failures.
      }
      setIsStoppingOllama(false);
    }
  };

  const loadAvailableModels = async (preservePageDraft = false) => {
    if (!preservePageDraft) {
      setPickerModelDraft(
        configuredLocalModelName || resolvedDefaultLocalModelName,
      );
      setIsAddingModelInPicker(false);
    }
    setIsModelListLoading(true);
    try {
      const models = await invoke<string[]>("list_ollama_models");
      setAvailableModels(models);
    } catch (error) {
      showStatusError(error, copy.listModelsFailed, {
        action: "loadAvailableModels",
        preservePageDraft,
      });
      setAvailableModels([]);
    } finally {
      setIsModelListLoading(false);
    }
  };

  const handleDownloadModelFromPicker = async () => {
    const normalizedModelName = pickerModelDraft.trim();
    if (normalizedModelName.length === 0) return;
    if (looksLikeCloudModelName(normalizedModelName)) {
      setPickerValidationMessage(copy.modelNameCloudHint);
      return;
    }
    try {
      setIsValidatingPickerModelName(true);
      setPickerValidationMessage(copy.validatingModel);
      await invoke("start_local_model_run", { model: normalizedModelName });
      const validation = await waitForLocalModelValidation(normalizedModelName);
      if (!validation.ready) {
        setPickerValidationMessage(validation.reason ?? copy.modelNameInvalid);
        return;
      }
      setPickerValidationMessage("");
      setIsAddingModelInPicker(false);
      setPendingLocalDownloadModel(normalizedModelName);
    } catch (error) {
      if (isLocalModelRunAlreadyInProgressError(error)) {
        const validation =
          await waitForLocalModelValidation(normalizedModelName);
        if (!validation.ready) {
          setPickerValidationMessage(
            validation.reason ?? describeError(error, copy.modelNameInvalid),
          );
          setPendingLocalDownloadModel("");
          return;
        }
        setPickerValidationMessage("");
        setIsAddingModelInPicker(false);
        setPendingLocalDownloadModel(normalizedModelName);
        return;
      }
      setPickerValidationMessage(describeError(error, copy.modelNameInvalid));
      setPendingLocalDownloadModel("");
      showStatusError(error, copy.pullModelFailed, {
        action: "handleDownloadModelFromPicker",
        model: normalizedModelName,
      });
    } finally {
      setIsValidatingPickerModelName(false);
    }
  };

  const handleActivateLocalModel = async (modelName: string) => {
    const normalized = modelName.trim();
    if (normalized.length === 0) return;
    try {
      setIsSavingLocalModelSelection(true);
      await invoke("save_local_model_selection", { model: normalized });
      setModelToPull(normalized);
      setLocalModelName(normalized);
      setPendingLocalModelSelection(normalized);
      await loadOpenClawModels();
      await refreshMainState(selectedLanguage);
      setLocalModelToggleDraftEnabled(false);
    } catch (error) {
      showStatusError(error, copy.switchModelFailed, {
        action: "handleActivateLocalModel",
        model: normalized,
      });
    } finally {
      setIsSavingLocalModelSelection(false);
    }
  };

  const handleSavePendingLocalModelSelection = async () => {
    await handleActivateLocalModel(pendingLocalModelSelection);
  };

  const restoreLocalModelPageFromConfig = () => {
    setLocalModelToggleDraftEnabled(false);
    setPendingLocalModelSelection(configuredLocalModelName);
    setPickerModelDraft(
      configuredLocalModelName || resolvedDefaultLocalModelName,
    );
    setIsAddingModelInPicker(false);
  };

  const openLocalModelConfigPage = async (
    preservePageDraft = false,
    openWithToggleDraft = false,
  ) => {
    setConfigPage("local-model");
    if (preservePageDraft && localModelPageDraft) {
      setLocalModelToggleDraftEnabled(localModelPageDraft.toggleEnabled);
      setPendingLocalModelSelection(localModelPageDraft.pendingSelection);
      setPickerModelDraft(localModelPageDraft.pickerDraft);
      setIsAddingModelInPicker(localModelPageDraft.isAddingModel);
      await loadAvailableModels(true);
      return;
    }

    restoreLocalModelPageFromConfig();
    if (openWithToggleDraft) {
      setLocalModelToggleDraftEnabled(true);
    }
    await loadAvailableModels(false);
  };

  const handleConfirmLocalModelToggle = async () => {
    if (pendingLocalModelToggleAction === "enable") {
      const nextOllamaStatus = await handleStartOllama();
      if (nextOllamaStatus?.running) {
        setPendingLocalModelToggleAction(null);
        await openLocalModelConfigPage(shouldShowLocalDownloadProgress, true);
      }
      return;
    }

    if (pendingLocalModelToggleAction === "disable") {
      setPendingLocalModelToggleAction(null);
      showStatusMessage(copy.localModelTogglePendingDisable, {
        action: "handleConfirmLocalModelToggle",
        toggleAction: "disable",
      });
      setConfigPage("model");
      await loadOpenClawModels();
    }
  };

  const handleSavePendingOpenClawModelSelection = async () => {
    const normalized = pendingOpenClawModelSelection.trim();
    if (normalized.length === 0) return;
    await handleSwitchOpenClawModel(normalized);
  };

  const handleStopLocalDownload = async () => {
    setIsStoppingLocalDownload(true);
    try {
      await invoke("stop_local_model_run");
      setPendingLocalDownloadModel("");
      setLocalModelRunProgress(null);
      setIsStopLocalDownloadConfirmOpen(false);
    } catch (error) {
      showStatusError(error, copy.stopDownloadFailed, {
        action: "handleStopLocalDownload",
        pendingLocalDownloadModel,
      });
    } finally {
      setIsStoppingLocalDownload(false);
    }
  };

  useEffect(() => {
    if (isBackgroundDownloadRunning) {
      setPendingLocalDownloadModel("");
      return;
    }

    if (!localModelRunProgress?.running) {
      setPendingLocalDownloadModel("");
    }
  }, [isBackgroundDownloadRunning, localModelRunProgress?.running]);

  useEffect(() => {
    if (shouldShowLocalDownloadProgress) return;
    setIsStopLocalDownloadConfirmOpen(false);
  }, [shouldShowLocalDownloadProgress]);

  useEffect(() => {
    if (!shouldShowLocalDownloadProgress) {
      setLocalModelPageDraft(null);
      return;
    }

    setLocalModelPageDraft({
      toggleEnabled: localModelToggleDraftEnabled,
      pendingSelection: pendingLocalModelSelection,
      pickerDraft: pickerModelDraft,
      isAddingModel: isAddingModelInPicker,
    });
  }, [
    shouldShowLocalDownloadProgress,
    localModelToggleDraftEnabled,
    pendingLocalModelSelection,
    pickerModelDraft,
    isAddingModelInPicker,
  ]);

  useEffect(() => {
    if (mainNav === "config") return;
    setConfigPage(null);
  }, [mainNav]);

  useEffect(() => {
    if (configPage !== "local-model") return;
    if (shouldShowLocalDownloadProgress && localModelPageDraft) return;
    restoreLocalModelPageFromConfig();
  }, [
    configuredLocalModelName,
    configPage,
    shouldShowLocalDownloadProgress,
    localModelPageDraft,
    localModelPlaceholder,
  ]);

  useEffect(() => {
    if (configPage !== "model") return;
    setPendingOpenClawModelSelection(currentOpenClawModel?.key ?? "");
  }, [configPage, currentOpenClawModel?.key]);

  useEffect(() => {
    if (configPage !== "skill") return;
    contentScrollContainerRef.current?.scrollTo({ top: 0, behavior: "smooth" });
  }, [configPage]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;

    void listen<string>("clawhub-skill-installed", () => {
      void loadInstalledSkills();
    }).then((nextUnlisten) => {
      if (disposed) {
        nextUnlisten();
      } else {
        unlisten = nextUnlisten;
      }
    });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  if (shouldShowLaunchSplash) {
    return (
      <main className="flex min-h-dvh items-center justify-center px-6 py-10">
        <section className="flex w-full max-w-sm flex-col items-center rounded-[2rem] border border-white/70 bg-white/72 px-8 py-10 text-center shadow-[0_24px_80px_rgba(15,23,42,0.14)] backdrop-blur-2xl">
          <div className="whereclaw-splash-shell relative mb-6 inline-flex h-24 items-center justify-center rounded-[1.75rem] border border-white/80 bg-white/90 px-6">
            <div className="pointer-events-none absolute inset-0 rounded-[inherit] bg-[linear-gradient(135deg,rgba(0,122,255,0.14),rgba(255,255,255,0.06),rgba(124,58,237,0.14))]" />
            <img
              alt="WhereClaw logo"
              className="whereclaw-splash-logo relative h-14 w-auto object-contain"
              src="/WhereClaw-logo.png"
            />
          </div>
          <div className="mt-6 h-1.5 w-28 overflow-hidden rounded-full bg-slate-200/80">
            <span className="whereclaw-progress-bar block h-full w-1/3 rounded-full bg-gradient-to-r from-[#007AFF] via-[#4F8CFF] to-[#7C3AED]" />
          </div>
        </section>
      </main>
    );
  }

  if (screen === "language") {
    return (
      <main className={appFrameClass}>
        <section className="flex w-full max-w-xl flex-col items-center justify-center p-2 sm:min-h-[22rem]">
          <div className="w-full max-w-md space-y-3">
            {copy.languages.map((language) => {
              const active = selectedLanguage === language.code;
              return (
                <button
                  key={language.code}
                  className={`${choiceButtonClass} w-full rounded-[1.25rem] px-5 py-4 text-center text-lg ${
                    active
                      ? choiceButtonActiveClass
                      : "border-slate-300/80 bg-transparent text-slate-950 hover:border-slate-500"
                  }`}
                  disabled={isSaving}
                  onClick={() => void handleSelectLanguage(language.code)}
                  type="button"
                  title={active ? copy.selected : undefined}
                >
                  <span>{language.label}</span>
                </button>
              );
            })}
          </div>

          {isSaving ? (
            <p className="mt-4 text-center text-sm text-slate-500">
              {copy.saving}
            </p>
          ) : null}
        </section>
      </main>
    );
  }

  if (screen === "model") {
    const modelStepUiState = getModelStepUiState({
      wantsLocalModel,
      localModelName,
      isValidatingLocalModelName,
    });
    const disableContinue = supportsLocalModels
      ? modelStepUiState.disableContinue
      : wantsCloudModel === null ||
        (wantsCloudModel &&
          (cloudBaseUrl.trim().length === 0 ||
            cloudApiKey.trim().length === 0 ||
            cloudModelName.trim().length === 0));

    return (
      <main className={appFrameClass}>
        <div className="w-full max-w-xl">
          <section className={onboardingCardClass}>
            <h2 className={titleClass}>
              {supportsLocalModels
                ? copy.modelQuestion
                : copy.cloudModelQuestion}
            </h2>

            {supportsLocalModels ? (
              <>
                <div className="mt-6 grid grid-cols-2 gap-3">
                  <button
                    className={`${choiceButtonClass} ${
                      wantsLocalModel === true
                        ? choiceButtonActiveClass
                        : choiceButtonInactiveClass
                    }`}
                    onClick={() => setWantsLocalModel(true)}
                    type="button"
                  >
                    {copy.yes}
                  </button>
                  <button
                    className={`${choiceButtonClass} ${
                      wantsLocalModel === false
                        ? choiceButtonActiveClass
                        : choiceButtonInactiveClass
                    }`}
                    onClick={() => setWantsLocalModel(false)}
                    type="button"
                  >
                    {copy.no}
                  </button>
                </div>

                {modelStepUiState.showNoLocalModelHint ? (
                  <div className="mt-5 rounded-[1.1rem] border border-sky-200 bg-sky-50/80 p-4 text-left text-sm leading-6 text-sky-900">
                    {copy.modelNoLocalHint}
                  </div>
                ) : null}

                {wantsLocalModel ? (
                  <div className="mt-5 space-y-3">
                    <label className={formLabelClass}>
                      {copy.modelNameLabel}
                    </label>
                    <input
                      className={inputClass}
                      disabled={isValidatingLocalModelName}
                      onChange={(event) =>
                        setLocalModelName(event.target.value)
                      }
                      placeholder={localModelPlaceholder}
                      type="text"
                      value={localModelName}
                    />
                    {isValidatingLocalModelName || modelStepMessage ? (
                      <p
                        className={`text-sm ${isValidatingLocalModelName ? "text-slate-500" : "text-red-600"}`}
                      >
                        {isValidatingLocalModelName
                          ? copy.validatingModel
                          : modelStepMessage}
                      </p>
                    ) : null}
                    <p className="flex flex-wrap items-center gap-2 text-sm text-slate-500">
                      <button
                        className="font-medium text-slate-800 underline underline-offset-4 hover:text-slate-950"
                        onClick={() => void handleOpenModelSearch()}
                        type="button"
                      >
                        {copy.modelSearchLinkLabel}
                      </button>
                      <span>{`${copy.modelSearchInstructionPrefix}${copy.modelSearchInstructionExample}`}</span>
                    </p>
                    {renderMemoryHint()}
                  </div>
                ) : null}
              </>
            ) : (
              <>
                <div className="mt-6 grid grid-cols-2 gap-3">
                  <button
                    className={`${choiceButtonClass} ${
                      wantsCloudModel === true
                        ? choiceButtonActiveClass
                        : choiceButtonInactiveClass
                    }`}
                    onClick={() => setWantsCloudModel(true)}
                    type="button"
                  >
                    {copy.yes}
                  </button>
                  <button
                    className={`${choiceButtonClass} ${
                      wantsCloudModel === false
                        ? choiceButtonActiveClass
                        : choiceButtonInactiveClass
                    }`}
                    onClick={() => setWantsCloudModel(false)}
                    type="button"
                  >
                    {copy.no}
                  </button>
                </div>

                {wantsCloudModel === false ? (
                  <div className="mt-5 rounded-[1.1rem] border border-sky-200 bg-sky-50/80 p-4 text-left text-sm leading-6 text-sky-900">
                    {copy.modelNoLocalHint}
                  </div>
                ) : null}

                {wantsCloudModel ? (
                  <div className="mt-5 space-y-3">
                    <p className="rounded-[1.1rem] border border-slate-200/80 bg-slate-50/80 p-4 text-left text-sm leading-6 text-slate-600">
                      {copy.cloudConfigHint}
                    </p>
                    <label className={formLabelClass}>
                      {copy.cloudBaseUrlLabel}
                    </label>
                    <input
                      className={inputClass}
                      onChange={(event) => setCloudBaseUrl(event.target.value)}
                      placeholder={copy.cloudBaseUrlPlaceholder}
                      type="text"
                      value={cloudBaseUrl}
                    />
                    <label className={formLabelClass}>
                      {copy.cloudApiKeyLabel}
                    </label>
                    <input
                      className={inputClass}
                      onChange={(event) => setCloudApiKey(event.target.value)}
                      placeholder={copy.cloudApiKeyPlaceholder}
                      type="password"
                      value={cloudApiKey}
                    />
                    <label className={formLabelClass}>
                      {copy.cloudModelNameLabel}
                    </label>
                    <input
                      className={inputClass}
                      onChange={(event) =>
                        setCloudModelName(event.target.value)
                      }
                      placeholder={copy.cloudModelNamePlaceholder}
                      type="text"
                      value={cloudModelName}
                    />
                    {modelStepMessage ? (
                      <p className="text-sm text-red-600">{modelStepMessage}</p>
                    ) : null}
                  </div>
                ) : null}
              </>
            )}
          </section>

          <div className="mt-4 flex items-center justify-between px-1">
            <button
              aria-label={copy.backAriaLabel}
              className={iconButtonClass}
              disabled={isValidatingLocalModelName}
              onClick={() => {
                setModelStepMessage("");
                setScreen("language");
              }}
              type="button"
            >
              <ChevronLeftIcon />
            </button>
            <button
              aria-label={copy.nextAriaLabel}
              className={iconButtonClass}
              disabled={disableContinue}
              onClick={() => void handleContinueModelStep()}
              type="button"
            >
              {isValidatingLocalModelName ? (
                <SpinnerIcon />
              ) : (
                <ChevronRightIcon />
              )}
            </button>
          </div>
        </div>
      </main>
    );
  }

  if (screen === "channel") {
    const channelContinueButtonState = getChannelContinueButtonState({
      selectedChannel,
      qqAppId,
      qqAppSecret,
      isApplyingInitialSetup,
      isStartingWeixinLogin,
      isWaitingForWeixinLogin,
    });
    const disableContinue = channelContinueButtonState.disabled;

    return (
      <main className={appFrameClass}>
        <div className="w-full max-w-xl">
          <section className={onboardingCardClass}>
            <h2 className={titleClass}>{copy.channelQuestion}</h2>
            <p className={`mt-3 text-center ${bodyTextClass}`}>
              {copy.channelDescription}
            </p>

            <div className="mt-6 grid grid-cols-3 gap-3">
              <button
                className={`${choiceButtonClass} ${
                  selectedChannel === "weixin"
                    ? choiceButtonActiveClass
                    : choiceButtonInactiveClass
                }`}
                disabled={isApplyingInitialSetup || isWaitingForWeixinLogin}
                onClick={() => {
                  setSelectedChannel("weixin");
                  setWeixinQrImageSrc(null);
                  setWeixinLoginMessage("");
                }}
                type="button"
              >
                {copy.channelWeixinLabel}
              </button>
              <button
                className={`${choiceButtonClass} ${
                  selectedChannel === "qq"
                    ? choiceButtonActiveClass
                    : choiceButtonInactiveClass
                }`}
                disabled={isApplyingInitialSetup || isWaitingForWeixinLogin}
                onClick={() => {
                  setSelectedChannel("qq");
                  setWeixinQrImageSrc(null);
                  setWeixinLoginMessage("");
                }}
                type="button"
              >
                {copy.channelQqLabel}
              </button>
              <button
                className={`${choiceButtonClass} ${
                  selectedChannel === "none"
                    ? choiceButtonActiveClass
                    : choiceButtonInactiveClass
                }`}
                disabled={isApplyingInitialSetup || isWaitingForWeixinLogin}
                onClick={() => {
                  setSelectedChannel("none");
                  setWeixinQrImageSrc(null);
                  setWeixinLoginMessage("");
                }}
                type="button"
              >
                {copy.channelSkipLabel}
              </button>
            </div>

            {selectedChannel === "weixin" ? (
              <div className="mt-5 space-y-3">
                <div className="rounded-[1.1rem] border border-slate-200 bg-slate-50/65 p-4 text-left">
                  <p className="text-sm font-medium text-slate-900">
                    {copy.weixinStepTitle}
                  </p>
                  <p className="mt-2 text-sm leading-6 text-slate-600">
                    {copy.weixinDescription}
                  </p>
                  <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm leading-6 text-slate-600">
                    {copy.weixinStepLines.map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                  </ol>
                </div>
                <div className="rounded-[1.1rem] border border-slate-200 bg-white p-4 text-center">
                  {weixinQrImageSrc ? (
                    <div className="space-y-3">
                      <p className="text-sm text-slate-600">
                        {isWaitingForWeixinLogin
                          ? copy.weixinQrWaiting
                          : copy.weixinQrReady}
                      </p>
                      <img
                        alt={copy.weixinQrAlt}
                        className="mx-auto w-full max-w-[16rem] rounded-xl border border-slate-200 bg-white p-3"
                        src={weixinQrImageSrc}
                      />
                    </div>
                  ) : (
                    <p className="text-sm text-slate-600">
                      {weixinLoginMessage || copy.weixinQrPending}
                    </p>
                  )}
                  {weixinLoginMessage && weixinQrImageSrc ? (
                    <p className="mt-3 text-sm text-slate-600">
                      {weixinLoginMessage}
                    </p>
                  ) : null}
                </div>
              </div>
            ) : null}

            {selectedChannel === "qq" ? (
              <div className="mt-5 space-y-3">
                <div className="rounded-[1.1rem] border border-slate-200 bg-slate-50/65 p-4 text-left">
                  <p className="text-sm font-medium text-slate-900">
                    {copy.qqStepTitle}
                  </p>
                  <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm leading-6 text-slate-600">
                    <li>
                      <a
                        className="font-medium text-slate-800 underline underline-offset-4 hover:text-slate-950"
                        href="https://q.qq.com/qqbot/openclaw/"
                        onClick={(event) => {
                          event.preventDefault();
                          void handleOpenQqOpenPlatform();
                        }}
                      >
                        {copy.qqStepLinkLabel}
                      </a>
                    </li>
                    {copy.qqStepLines.map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                  </ol>
                </div>
                <div className="space-y-3">
                  <div>
                    <label className={formLabelClass}>
                      {copy.qqAppIdLabel}
                    </label>
                    <input
                      className={`mt-2 ${inputClass}`}
                      disabled={isApplyingInitialSetup}
                      onChange={(event) => setQqAppId(event.target.value)}
                      type="text"
                      value={qqAppId}
                    />
                  </div>
                  <div>
                    <label className={formLabelClass}>
                      {copy.qqAppSecretLabel}
                    </label>
                    <input
                      className={`mt-2 ${inputClass}`}
                      disabled={isApplyingInitialSetup}
                      onChange={(event) => setQqAppSecret(event.target.value)}
                      type="text"
                      value={qqAppSecret}
                    />
                  </div>
                </div>
              </div>
            ) : null}

            {selectedChannel === "none" ? (
              <div className="mt-5 rounded-[1.1rem] border border-slate-200 bg-slate-50/65 p-4 text-left text-sm leading-6 text-slate-600">
                {copy.channelSkipLabel}
              </div>
            ) : null}

            {statusMessage ? (
              <p className="mt-4 text-center text-sm text-red-600">
                {statusMessage}
              </p>
            ) : null}
          </section>

          <div className="mt-4 flex items-center justify-between px-1">
            <button
              aria-label={copy.backAriaLabel}
              className={iconButtonClass}
              disabled={isApplyingInitialSetup || isWaitingForWeixinLogin}
              onClick={() => {
                clearStatusMessage({
                  action: "navigateBackFromChannelScreen",
                  nextScreen: "model",
                });
                setScreen("model");
              }}
              type="button"
            >
              <ChevronLeftIcon />
            </button>
            <button
              aria-busy={channelContinueButtonState.showLoading}
              aria-label={
                channelContinueButtonState.showLoading
                  ? selectedChannel === "weixin"
                    ? copy.weixinQrWaiting
                    : copy.loading
                  : copy.nextAriaLabel
              }
              className={iconButtonClass}
              disabled={disableContinue}
              onClick={() => void handleContinueChannelStep()}
              type="button"
            >
              {channelContinueButtonState.showLoading ? (
                <SpinnerIcon />
              ) : (
                <ChevronRightIcon />
              )}
            </button>
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className={appFrameClass}>
      <div className="mx-auto flex h-[calc(100dvh-2rem)] w-full max-w-6xl flex-col gap-3 p-4 sm:h-[calc(100dvh-2.5rem)] sm:p-5 lg:h-[calc(100dvh-3rem)] lg:p-6">
        <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[16rem_minmax(0,1fr)]">
          <aside className="flex h-full flex-col rounded-3xl bg-white/72 p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.9)] backdrop-blur-2xl sm:p-5">
            <div>
              <div className="flex h-10 items-center">
                <img
                  alt="WhereClaw logo"
                  className="h-8 w-auto object-contain"
                  src="/WhereClaw-logo.png"
                />
              </div>
              <div className="mt-1 flex items-center justify-center gap-1.5 text-sm text-slate-500">
                <p>{consoleVersionLabel}</p>
              </div>
            </div>

            <nav className="mt-6 space-y-2">
              <button
                className={`${sideNavButtonClass} ${mainNav === "overview" ? sideNavButtonActiveClass : sideNavButtonInactiveClass}`}
                onClick={() => {
                  setMainNav("overview");
                  setConfigPage(null);
                }}
                type="button"
              >
                <span className="inline-flex h-4 w-4 items-center justify-center">
                  <OverviewIcon />
                </span>
                <span>{copy.navOverview}</span>
              </button>
              <button
                className={`${sideNavButtonClass} ${mainNav === "config" ? sideNavButtonActiveClass : sideNavButtonInactiveClass}`}
                onClick={() => {
                  setMainNav("config");
                  setConfigPage(null);
                }}
                type="button"
              >
                <span className="inline-flex h-4 w-4 items-center justify-center">
                  <ConfigIcon />
                </span>
                <span>{copy.navConfig}</span>
              </button>
            </nav>

            <div className="relative mt-auto flex items-center gap-2 pt-4">
              {isMoreMenuOpen ? (
                <div className="absolute bottom-12 right-0 z-20 min-w-40 rounded-2xl border border-white/90 bg-white/92 p-1.5 shadow-[0_18px_40px_rgba(15,23,42,0.14),inset_0_1px_0_rgba(255,255,255,0.92)] backdrop-blur-xl">
                  <button
                    className={sideNavButtonClass}
                    disabled={
                      isOpeningSetup ||
                      isOpeningTerminal ||
                      isOpeningConfigFile ||
                      isStartingGateway ||
                      isStoppingGateway ||
                      isResettingOpenClaw
                    }
                    onClick={() => {
                      void handleOpenWhereClawTerminal();
                    }}
                    type="button"
                  >
                    <span className="inline-flex h-4 w-4 items-center justify-center">
                      <TerminalIcon />
                    </span>
                    <span>
                      {isOpeningTerminal
                        ? copy.openingTerminal
                        : copy.openTerminal}
                    </span>
                  </button>
                  <button
                    className={sideNavButtonClass}
                    disabled={
                      isOpeningSetup ||
                      isOpeningTerminal ||
                      isOpeningConfigFile ||
                      isStartingGateway ||
                      isStoppingGateway ||
                      isResettingOpenClaw
                    }
                    onClick={() => {
                      setIsSetupConfirmOpen(true);
                      setIsMoreMenuOpen(false);
                    }}
                    type="button"
                  >
                    <span className="inline-flex h-4 w-4 items-center justify-center">
                      <SetupIcon />
                    </span>
                    <span>{copy.openSetup}</span>
                  </button>
                  <button
                    className={sideNavButtonClass}
                    disabled={
                      isOpeningSetup ||
                      isOpeningTerminal ||
                      isOpeningConfigFile ||
                      isStartingGateway ||
                      isStoppingGateway ||
                      isResettingOpenClaw
                    }
                    onClick={() => {
                      void handleOpenConfigFile();
                    }}
                    type="button"
                  >
                    <span className="inline-flex h-4 w-4 items-center justify-center">
                      <FileIcon />
                    </span>
                    <span>{copy.openConfigFile}</span>
                  </button>
                  <button
                    className={`${sideNavButtonClass} ${mainNav === "logs" ? sideNavButtonActiveClass : sideNavButtonInactiveClass}`}
                    onClick={() => {
                      setMainNav("logs");
                      setConfigPage(null);
                      setIsMoreMenuOpen(false);
                      void loadLauncherLogs(selectedLogSource);
                    }}
                    type="button"
                  >
                    <span className="inline-flex h-4 w-4 items-center justify-center">
                      <LogsIcon />
                    </span>
                    <span>{copy.navLogs}</span>
                  </button>
                  {selectedLanguage === "zh-CN" ? (
                    <button
                      className={sideNavButtonClass}
                      onClick={() => {
                        void handleCopyQqGroupNumber();
                      }}
                      type="button"
                    >
                      <span className="inline-flex h-4 w-4 items-center justify-center">
                        <QqGroupIcon />
                      </span>
                      <span>{copy.qqGroupMenuLabel}</span>
                    </button>
                  ) : null}
                </div>
              ) : null}
              <button
                aria-label={copy.officialWebsiteLabel}
                className={bottomNavIconButtonClass}
                onClick={() => void handleOpenWhereClawWebsite()}
                title={copy.officialWebsiteLabel}
                type="button"
              >
                <WebsiteIcon />
              </button>
              <button
                aria-label={copy.preferences}
                className={bottomNavIconButtonClass}
                onClick={() => {
                  clearStatusMessage({
                    action: "openLanguageSheet",
                  });
                  setIsLanguageSheetOpen(true);
                }}
                title={copy.preferences}
                type="button"
              >
                <LanguageIcon />
              </button>
              <button
                aria-label={copy.resetOpenClaw}
                className={bottomNavIconButtonClass}
                disabled={
                  isResettingOpenClaw || isStartingGateway || isStoppingGateway
                }
                onClick={() => setIsResetConfirmOpen(true)}
                title={copy.resetOpenClaw}
                type="button"
              >
                <ResetIcon />
              </button>
              <button
                aria-label={copy.navMore}
                className={bottomNavIconButtonClass}
                onClick={() => setIsMoreMenuOpen((current) => !current)}
                title={copy.navMore}
                type="button"
              >
                <MoreIcon />
              </button>
            </div>
          </aside>

          <section
            className="h-full overflow-y-auto rounded-3xl bg-white/72 p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.9)] backdrop-blur-2xl sm:p-5"
            ref={contentScrollContainerRef}
          >
            {mainNav === "overview" ? (
              <>
                <div className="flex min-h-full flex-col gap-4">
                  <div className="px-1 pt-1">
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-[0.24em] text-slate-400">
                        {copy.navOverview}
                      </p>
                      <h2 className="mt-2 text-[2rem] font-semibold tracking-[-0.04em] text-slate-950">
                        {copy.navOverview}
                      </h2>
                    </div>
                  </div>

                  <div className="grid gap-4 xl:grid-cols-2">
                    {supportsLocalModels && shouldShowLocalModelOverviewCard ? (
                      <section className="rounded-3xl bg-transparent p-5 shadow-[0_16px_48px_rgba(15,23,42,0.12),inset_0_1px_0_rgba(255,255,255,0.9)] backdrop-blur-0">
                        <div className="flex items-start justify-between gap-3">
                          <div className="flex items-start gap-4">
                            <span className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-emerald-100 text-emerald-600 shadow-[inset_0_1px_0_rgba(255,255,255,0.9)]">
                              <LocalModelOverviewIcon />
                            </span>
                            <div className="space-y-2">
                              <p className="text-xs uppercase tracking-[0.24em] text-slate-400">
                                {copy.ollamaTitle}
                              </p>
                              <h2 className="text-[1.6rem] font-semibold tracking-[-0.03em] text-slate-950">
                                {localModelStatusLabel}
                              </h2>
                            </div>
                          </div>
                          <div className="inline-flex items-center gap-2 rounded-full border border-white/85 bg-white/70 px-3 py-1.5 text-xs text-slate-600">
                            <span
                              className={`h-2.5 w-2.5 rounded-full ${isOllamaReady ? "bg-emerald-500 whereclaw-status-pulse" : "bg-slate-400"}`}
                            />
                            <span>{localModelStatusLabel}</span>
                          </div>
                        </div>

                        <div className="mt-4 text-sm leading-6 text-slate-500">
                          <p>
                            {copy.currentModelLabel}:{" "}
                            <span className="font-semibold text-slate-800">
                              {localModelOverviewDisplayName}
                            </span>
                          </p>
                        </div>

                        <div className="mt-4 grid gap-3 sm:grid-cols-2">
                          <button
                            className={secondaryButtonClass}
                            disabled={isOllamaReady || isStartingOllama}
                            onClick={() => void handleStartOllama()}
                            type="button"
                          >
                            {isStartingOllama
                              ? copy.startingOllama
                              : copy.startOllama}
                          </button>
                          <button
                            className={secondaryButtonClass}
                            disabled={!isOllamaReady || isStoppingOllama}
                            onClick={() => void handleStopOllama()}
                            type="button"
                          >
                            {isStoppingOllama
                              ? copy.stoppingOllama
                              : copy.stopOllama}
                          </button>
                        </div>

                        {shouldShowLocalDownloadProgress ? (
                          <div className="mt-4 space-y-2">
                            <div className="flex items-center justify-between gap-3 text-xs text-slate-500">
                              <p className="uppercase tracking-[0.2em]">
                                {localModelRunProgress?.hasKnownProgress
                                  ? `${Math.round(localModelRunProgress.progress * 100)}%`
                                  : "--%"}
                              </p>
                              <p className="text-right">
                                {localModelRunProgress
                                  ? formatTransferInfo(localModelRunProgress) ||
                                    "--"
                                  : "--"}
                              </p>
                            </div>
                            <div className="flex items-center gap-3">
                              <div className="h-2 flex-1 overflow-hidden rounded-full bg-slate-200/80">
                                {localModelRunProgress?.hasKnownProgress ? (
                                  <div
                                    className="h-full rounded-full bg-[#007AFF] transition-[width] duration-300"
                                    style={{
                                      width: `${Math.max(3, Math.min(100, Math.round(localModelRunProgress.progress * 100)))}%`,
                                    }}
                                  />
                                ) : (
                                  <div className="whereclaw-progress-bar h-full w-1/3 rounded-full bg-[#007AFF]" />
                                )}
                              </div>
                              <button
                                aria-label={copy.stopDownload}
                                className={dangerIconButtonClass}
                                disabled={isStoppingLocalDownload}
                                onClick={() =>
                                  setIsStopLocalDownloadConfirmOpen(true)
                                }
                                title={copy.stopDownload}
                                type="button"
                              >
                                <CloseIcon />
                              </button>
                            </div>
                          </div>
                        ) : null}
                      </section>
                    ) : null}

                    <section className="rounded-3xl bg-transparent p-5 shadow-[0_16px_48px_rgba(15,23,42,0.12),inset_0_1px_0_rgba(255,255,255,0.9)] backdrop-blur-0">
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex items-start gap-4">
                          <span className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-sky-100 text-sky-600 shadow-[inset_0_1px_0_rgba(255,255,255,0.9)]">
                            <OpenClawOverviewIcon />
                          </span>
                          <div className="space-y-2">
                            <p className="text-xs uppercase tracking-[0.28em] text-slate-400">
                              OpenClaw
                            </p>
                            <h2 className="text-[1.6rem] font-semibold tracking-[-0.03em] text-slate-950">
                              {openClawStatusLabel}
                            </h2>
                          </div>
                        </div>
                        <div className="inline-flex items-center gap-2 rounded-full border border-white/85 bg-white/70 px-3 py-1.5 text-xs text-slate-600">
                          <span
                            className={`h-2.5 w-2.5 rounded-full ${isReady ? "bg-emerald-500 whereclaw-status-pulse" : "bg-slate-400"}`}
                          />
                          <span>{openClawStatusLabel}</span>
                        </div>
                      </div>

                      <div className="mt-4 text-sm leading-6 text-slate-500">
                        <p>
                          {copy.currentModelLabel}:{" "}
                          <span className="font-semibold text-slate-800">
                            {openClawOverviewDisplayName}
                          </span>
                        </p>
                      </div>

                      {gatewayStatusCardState.showDownloadHintInCard ? (
                        <div className="mt-5 rounded-[1.1rem] border border-amber-200 bg-amber-50/85 p-4 text-sm leading-6 text-amber-900">
                          {copy.statusStartGatewayWaitForModelDownload(
                            configuredCurrentModelName || activeModelName,
                          )}
                        </div>
                      ) : null}

                      <div className="mt-5 grid gap-3 sm:grid-cols-2">
                        <button
                          className={secondaryButtonClass}
                          disabled={gatewayStartState.disabled}
                          onClick={() => {
                            if (isReady) {
                              void handleOpenControlUi();
                              return;
                            }

                            void handleStartGateway();
                          }}
                          type="button"
                        >
                          {isStartingGateway
                            ? copy.startingGateway
                            : isReady
                              ? copy.openControlUi
                              : copy.startGateway}
                        </button>
                        <button
                          className={secondaryButtonClass}
                          disabled={
                            !isReady || isStoppingGateway || isResettingOpenClaw
                          }
                          onClick={() => void handleStopGateway()}
                          type="button"
                        >
                          {isStoppingGateway
                            ? copy.stoppingGateway
                            : copy.stopGateway}
                        </button>
                      </div>
                    </section>
                  </div>

                  {statusMessage ? (
                    <section className="mt-auto rounded-3xl border border-white/80 bg-white/55 px-4 py-3 shadow-[0_10px_30px_rgba(15,23,42,0.08),inset_0_1px_0_rgba(255,255,255,0.9)] backdrop-blur-xl">
                      <p className="text-sm leading-6 text-slate-500">
                        {statusMessage}
                      </p>
                    </section>
                  ) : null}
                </div>
              </>
            ) : null}

            {mainNav === "config" ? (
              <div className="space-y-4">
                {configPage === null ? (
                  <>
                    <div className="px-1 pt-1">
                      <div>
                        <p className="text-xs font-semibold uppercase tracking-[0.24em] text-slate-400">
                          {copy.navConfig}
                        </p>
                        <h2 className="mt-2 text-[2rem] font-semibold tracking-[-0.04em] text-slate-950">
                          {copy.configCenterTitle}
                        </h2>
                      </div>
                    </div>

                    <div className="space-y-4">
                      {supportsLocalModels ? (
                        <button
                          className={configEntryCardClass}
                          onClick={() => {
                            void openLocalModelConfigPage(
                              shouldShowLocalDownloadProgress,
                            );
                          }}
                          type="button"
                        >
                          <span className="flex items-center gap-4">
                            <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-emerald-100 text-emerald-600">
                              <LocalModelConfigIcon />
                            </span>
                            <span className="min-w-0 text-left">
                              <span className="block text-[0.98rem] font-semibold tracking-[-0.03em] text-slate-950">
                                {copy.configCenterLocalModelTitle}
                              </span>
                              <span className="mt-1 block text-[0.84rem] leading-5 text-slate-500">
                                {copy.configCenterLocalModelDescription}
                              </span>
                            </span>
                          </span>
                          <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-slate-400">
                            <ChevronForwardIcon />
                          </span>
                        </button>
                      ) : null}

                      <button
                        className={configEntryCardClass}
                        onClick={() => {
                          setConfigPage("channel");
                          void loadChannelAccounts();
                        }}
                        type="button"
                      >
                        <span className="flex items-center gap-4">
                          <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-sky-100 text-sky-600">
                            <ChannelConfigIcon />
                          </span>
                          <span className="min-w-0 text-left">
                            <span className="block text-[0.98rem] font-semibold tracking-[-0.03em] text-slate-950">
                              {copy.configCenterChannelTitle}
                            </span>
                            <span className="mt-1 block text-[0.84rem] leading-5 text-slate-500">
                              {copy.configCenterChannelDescription}
                            </span>
                          </span>
                        </span>
                        <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-slate-400">
                          <ChevronForwardIcon />
                        </span>
                      </button>

                      <button
                        className={configEntryCardClass}
                        onClick={() => {
                          setConfigPage("model");
                          void loadOpenClawModels();
                        }}
                        type="button"
                      >
                        <span className="flex items-center gap-4">
                          <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-amber-100 text-amber-600">
                            <CloudModelConfigIcon />
                          </span>
                          <span className="min-w-0 text-left">
                            <span className="block text-[0.98rem] font-semibold tracking-[-0.03em] text-slate-950">
                              {copy.configCenterModelTitle}
                            </span>
                            <span className="mt-1 block text-[0.84rem] leading-5 text-slate-500">
                              {copy.configCenterModelDescription}
                            </span>
                          </span>
                        </span>
                        <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-slate-400">
                          <ChevronForwardIcon />
                        </span>
                      </button>

                      <button
                        className={configEntryCardClass}
                        onClick={() => {
                          setConfigPage("skill");
                          void loadInstalledSkills();
                        }}
                        type="button"
                      >
                        <span className="flex items-center gap-4">
                          <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-violet-100 text-violet-600">
                            <SkillConfigIcon />
                          </span>
                          <span className="min-w-0 text-left">
                            <span className="block text-[0.98rem] font-semibold tracking-[-0.03em] text-slate-950">
                              {copy.configCenterSkillTitle}
                            </span>
                            <span className="mt-1 block text-[0.84rem] leading-5 text-slate-500">
                              {copy.configCenterSkillDescription}
                            </span>
                          </span>
                        </span>
                        <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-slate-400">
                          <ChevronForwardIcon />
                        </span>
                      </button>
                    </div>
                  </>
                ) : null}

                {configPage === "local-model" ? (
                  <div className="space-y-4">
                    <div className="space-y-3 px-1 pt-1">
                      <button
                        aria-label={copy.configCenterBackAriaLabel}
                        className={configBackButtonClass}
                        onClick={() => setConfigPage(null)}
                        type="button"
                      >
                        <ChevronLeftIcon />
                      </button>
                      <div className="flex items-center gap-2 text-base text-slate-400">
                        <button
                          className="transition hover:text-slate-700"
                          onClick={() => setConfigPage(null)}
                          type="button"
                        >
                          {copy.configCenterBreadcrumb}
                        </button>
                        <span>/</span>
                        <span className="text-slate-600">
                          {copy.localModelConfigTitle}
                        </span>
                      </div>
                      <p className="mt-1 text-xs text-slate-500">
                        {copy.localModelConfigDescription}
                      </p>
                    </div>

                    <section className="rounded-3xl border border-white/85 bg-white/70 p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.9)] backdrop-blur-xl">
                      <div className="rounded-[1.25rem] border border-slate-200/80 bg-slate-50/80 p-4">
                        <div className="flex items-center justify-between gap-4">
                          <div>
                            <p className="text-sm font-semibold text-slate-950">
                              {isLocalModelToggleOn
                                ? copy.localModelToggleEnabled
                                : copy.localModelToggleDisabled}
                            </p>
                            <p className="mt-1 text-xs text-slate-500">
                              {isLocalModelToggleOn
                                ? copy.localModelToggleEnableHint
                                : copy.localModelToggleDisableHint}
                            </p>
                          </div>
                          <button
                            aria-label={
                              isLocalModelToggleOn
                                ? copy.localModelToggleTurnOff
                                : copy.localModelToggleTurnOn
                            }
                            aria-checked={isLocalModelToggleOn}
                            className={`relative inline-flex h-7 w-12 shrink-0 items-center rounded-full transition-all duration-200 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50 ${
                              isLocalModelToggleOn
                                ? "bg-emerald-500 shadow-[0_10px_24px_rgba(16,185,129,0.22)] hover:bg-emerald-600"
                                : "bg-slate-300 hover:bg-slate-400"
                            }`}
                            disabled={
                              isSavingLocalModelSelection || isStartingOllama
                            }
                            onClick={() => {
                              if (
                                localModelToggleDraftEnabled &&
                                !isLocalModelEnabled
                              ) {
                                setLocalModelToggleDraftEnabled(false);
                                return;
                              }
                              setPendingLocalModelToggleAction(
                                isLocalModelEnabled ? "disable" : "enable",
                              );
                            }}
                            role="switch"
                            type="button"
                          >
                            <span
                              aria-hidden="true"
                              className={`inline-block h-5 w-5 rounded-full bg-white shadow-[0_4px_10px_rgba(15,23,42,0.18)] transition-transform duration-200 ${
                                isLocalModelToggleOn
                                  ? "translate-x-6"
                                  : "translate-x-1"
                              }`}
                            />
                          </button>
                        </div>
                      </div>

                      {canManageLocalModels ? (
                        <>
                          <div className="mt-4 flex items-center justify-start">
                            {isAddingModelInPicker ? (
                              <button
                                aria-label={copy.modelPickerCancelAdd}
                                className={configAddIconButtonClass}
                                disabled={isSavingLocalModelSelection}
                                onClick={() => setIsAddingModelInPicker(false)}
                                title={copy.modelPickerCancelAdd}
                                type="button"
                              >
                                <CloseIcon />
                              </button>
                            ) : (
                              <button
                                aria-label={copy.modelPickerAddModel}
                                className={configAddIconButtonClass}
                                disabled={isSavingLocalModelSelection}
                                onClick={() => setIsAddingModelInPicker(true)}
                                title={copy.modelPickerAddModel}
                                type="button"
                              >
                                <PlusIcon />
                              </button>
                            )}
                          </div>

                          {shouldShowLocalDownloadProgress ? (
                            <div className="mt-4 rounded-[1rem] border border-[#007AFF]/15 bg-[#007AFF]/[0.04] p-4">
                              <div className="flex items-center justify-between gap-3">
                                <div className="min-w-0">
                                  <p className="truncate text-sm font-semibold text-slate-950">
                                    {localModelRunProgress?.model ||
                                      pendingLocalDownloadModel ||
                                      pendingLocalModelSelection ||
                                      activeModelName}
                                  </p>
                                  <p className="mt-1 text-xs text-slate-500">
                                    {localModelRunProgress?.hasKnownProgress
                                      ? `${Math.round(localModelRunProgress.progress * 100)}%`
                                      : copy.downloadPreparing}
                                  </p>
                                </div>
                                <p className="text-right text-xs text-slate-500">
                                  {localModelRunProgress
                                    ? formatTransferInfo(
                                        localModelRunProgress,
                                      ) || "--"
                                    : "--"}
                                </p>
                              </div>
                              <div className="mt-3 flex items-center gap-3">
                                <div className="h-2 flex-1 overflow-hidden rounded-full bg-slate-200/80">
                                  {localModelRunProgress?.hasKnownProgress ? (
                                    <div
                                      className="h-full rounded-full bg-[#007AFF] transition-[width] duration-300"
                                      style={{
                                        width: `${Math.max(3, Math.min(100, Math.round(localModelRunProgress.progress * 100)))}%`,
                                      }}
                                    />
                                  ) : (
                                    <div className="whereclaw-progress-bar h-full w-1/3 rounded-full bg-[#007AFF]" />
                                  )}
                                </div>
                                <button
                                  aria-label={copy.stopDownload}
                                  className={dangerIconButtonClass}
                                  disabled={isStoppingLocalDownload}
                                  onClick={() =>
                                    setIsStopLocalDownloadConfirmOpen(true)
                                  }
                                  title={copy.stopDownload}
                                  type="button"
                                >
                                  <CloseIcon />
                                </button>
                              </div>
                            </div>
                          ) : null}

                          {isAddingModelInPicker &&
                          !shouldShowLocalDownloadProgress ? (
                            <div className="mt-4 rounded-[1rem] border border-slate-200 bg-slate-50/65 p-3">
                              <div className="flex items-center justify-between gap-3">
                                <label className="block text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">
                                  {copy.modelNameLabel}
                                </label>
                                <button
                                  className="text-xs font-medium text-[#007AFF] transition hover:text-[#006AE6]"
                                  onClick={() => void handleOpenModelSearch()}
                                  type="button"
                                >
                                  {copy.modelSearchLinkLabel}
                                </button>
                              </div>
                              <div className="mt-2 flex items-center gap-2">
                                <input
                                  className={compactInputClass}
                                  disabled={
                                    isSavingLocalModelSelection ||
                                    isValidatingPickerModelName
                                  }
                                  onChange={(event) =>
                                    setPickerModelDraft(event.target.value)
                                  }
                                  placeholder={localModelPlaceholder}
                                  type="text"
                                  value={pickerModelDraft}
                                />
                                <button
                                  aria-label={copy.modelPickerDownloadModel}
                                  className={compactPrimaryIconButtonClass}
                                  disabled={
                                    pickerModelDraft.trim().length === 0 ||
                                    (localModelRunProgress?.running ?? false) ||
                                    isSavingLocalModelSelection ||
                                    isValidatingPickerModelName
                                  }
                                  onClick={() =>
                                    void handleDownloadModelFromPicker()
                                  }
                                  title={copy.modelPickerDownloadModel}
                                  type="button"
                                >
                                  {isValidatingPickerModelName ? (
                                    <SpinnerIcon />
                                  ) : (
                                    <DownloadIcon />
                                  )}
                                </button>
                              </div>
                              {pickerValidationMessage ? (
                                <p
                                  className={`mt-2 text-sm ${isValidatingPickerModelName ? "text-slate-500" : "text-red-600"}`}
                                >
                                  {pickerValidationMessage}
                                </p>
                              ) : null}
                              {renderMemoryHint()}
                            </div>
                          ) : null}

                          <div className="mt-4 space-y-2">
                            {isModelListLoading ? (
                              <p className="text-sm text-slate-500">
                                {copy.modelPickerLoading}
                              </p>
                            ) : visibleLocalModels.length === 0 ? (
                              <p className="text-sm text-slate-500">
                                {copy.modelPickerEmpty}
                              </p>
                            ) : (
                              visibleLocalModels.map((model) => {
                                const isActive = areLocalModelNamesEquivalent(
                                  model,
                                  pendingLocalModelSelection,
                                );
                                return (
                                  <button
                                    key={model}
                                    className={`${configListButtonClass} ${
                                      isActive
                                        ? configListButtonActiveClass
                                        : configListButtonInactiveClass
                                    }`}
                                    disabled={isSavingLocalModelSelection}
                                    onClick={() =>
                                      setPendingLocalModelSelection(model)
                                    }
                                    type="button"
                                  >
                                    <span className="truncate">{model}</span>
                                  </button>
                                );
                              })
                            )}
                          </div>

                          <div className="mt-4 flex justify-end">
                            <button
                              aria-label={copy.save}
                              className={compactConfirmIconButtonClass}
                              disabled={
                                pendingLocalModelSelection.trim().length ===
                                  0 ||
                                (isLocalModelEnabled &&
                                  !hasLocalModelSelectionChanged(
                                    pendingLocalModelSelection,
                                    configuredLocalModelName,
                                  )) ||
                                isSavingLocalModelSelection
                              }
                              onClick={() =>
                                handleSavePendingLocalModelSelection()
                              }
                              title={copy.save}
                              type="button"
                            >
                              {isSavingLocalModelSelection ? (
                                <SpinnerIcon />
                              ) : (
                                <CheckIcon />
                              )}
                            </button>
                          </div>
                        </>
                      ) : null}
                    </section>
                  </div>
                ) : null}

                {configPage === "channel" ? (
                  <div className="space-y-4">
                    <div className="space-y-3 px-1 pt-1">
                      <button
                        aria-label={copy.configCenterBackAriaLabel}
                        className={configBackButtonClass}
                        onClick={() => setConfigPage(null)}
                        type="button"
                      >
                        <ChevronLeftIcon />
                      </button>
                      <div className="flex items-center gap-2 text-base text-slate-400">
                        <button
                          className="transition hover:text-slate-700"
                          onClick={() => setConfigPage(null)}
                          type="button"
                        >
                          {copy.configCenterBreadcrumb}
                        </button>
                        <span>/</span>
                        <span className="text-slate-600">
                          {copy.configCenterChannelTitle}
                        </span>
                      </div>
                      <p className="mt-1 text-xs text-slate-500">
                        {copy.channelConfigDescription}
                      </p>
                    </div>

                    <section className="rounded-3xl border border-white/85 bg-white/70 p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.9)] backdrop-blur-xl">
                      <div className="flex items-center justify-start">
                        <button
                          aria-label={copy.channelManagerAdd}
                          className={configAddIconButtonClass}
                          disabled={isOpeningChannelWizard}
                          onClick={() => setIsChannelAddConfirmOpen(true)}
                          title={copy.channelManagerAdd}
                          type="button"
                        >
                          {isOpeningChannelWizard ? (
                            <SpinnerIcon />
                          ) : (
                            <PlusIcon />
                          )}
                        </button>
                      </div>

                      <div className="mt-4 space-y-2">
                        {isChannelListLoading ? (
                          <p className="text-sm text-slate-500">
                            {copy.channelManagerLoading}
                          </p>
                        ) : channelAccounts.length === 0 ? (
                          <p className="text-sm text-slate-500">
                            {copy.channelManagerEmpty}
                          </p>
                        ) : (
                          channelAccounts.map((entry) => {
                            const key = `${entry.channel}::${entry.accountId}`;
                            const isRemoving = removingChannelKey === key;
                            return (
                              <div
                                key={key}
                                className="flex items-center justify-between gap-3 rounded-[1rem] border border-slate-200 bg-white px-3 py-2"
                              >
                                <div className="min-w-0">
                                  <p className="truncate text-sm font-medium text-slate-900">
                                    {entry.channel}
                                  </p>
                                  <p className="truncate text-xs text-slate-500">
                                    {entry.accountId}
                                  </p>
                                </div>
                                <button
                                  className={dangerSubtleButtonClass}
                                  disabled={isRemoving}
                                  onClick={() =>
                                    void handleRemoveChannelAccount(
                                      entry.channel,
                                      entry.accountId,
                                    )
                                  }
                                  type="button"
                                >
                                  {isRemoving
                                    ? copy.channelManagerRemoving
                                    : copy.remove}
                                </button>
                              </div>
                            );
                          })
                        )}
                      </div>
                    </section>
                  </div>
                ) : null}

                {configPage === "model" ? (
                  <div className="space-y-4">
                    <div className="space-y-3 px-1 pt-1">
                      <button
                        aria-label={copy.configCenterBackAriaLabel}
                        className={configBackButtonClass}
                        onClick={() => setConfigPage(null)}
                        type="button"
                      >
                        <ChevronLeftIcon />
                      </button>
                      <div className="flex items-center gap-2 text-base text-slate-400">
                        <button
                          className="transition hover:text-slate-700"
                          onClick={() => setConfigPage(null)}
                          type="button"
                        >
                          {copy.configCenterBreadcrumb}
                        </button>
                        <span>/</span>
                        <span className="text-slate-600">
                          {copy.configCenterModelTitle}
                        </span>
                      </div>
                      <p className="mt-1 text-xs text-slate-500">
                        {copy.modelConfigDescription}
                      </p>
                    </div>

                    <section className="rounded-3xl border border-white/85 bg-white/70 p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.9)] backdrop-blur-xl">
                      <div className="flex items-center justify-start">
                        <button
                          aria-label={copy.modelManagerAddProvider}
                          className={configAddIconButtonClass}
                          disabled={isOpeningModelProviderWizard}
                          onClick={() => setIsModelProviderAddConfirmOpen(true)}
                          title={copy.modelManagerAddProvider}
                          type="button"
                        >
                          {isOpeningModelProviderWizard ? (
                            <SpinnerIcon />
                          ) : (
                            <PlusIcon />
                          )}
                        </button>
                      </div>

                      <div className="mt-4 space-y-3">
                        {isModelCatalogLoading ? (
                          <p className="text-sm text-slate-500">
                            {copy.modelManagerLoading}
                          </p>
                        ) : openClawModelsByProvider.length === 0 ? (
                          <p className="text-sm text-slate-500">
                            {copy.modelManagerEmpty}
                          </p>
                        ) : (
                          openClawModelsByProvider.map(
                            ([provider, entries]) => (
                              <div
                                key={provider}
                                className="overflow-hidden rounded-[1.35rem] border border-white/85 bg-[linear-gradient(180deg,rgba(248,250,252,0.96),rgba(255,255,255,0.9))] shadow-[0_14px_34px_rgba(15,23,42,0.06),inset_0_1px_0_rgba(255,255,255,0.92)]"
                              >
                                <div className="flex items-center justify-between gap-3 px-3 py-3">
                                  <div className="flex min-w-0 items-center gap-2">
                                    <p className="min-w-0 truncate text-sm font-semibold text-slate-900">
                                      {provider}
                                    </p>
                                    {supportsLocalModels &&
                                    provider === "ollama" ? (
                                      <span className="inline-flex items-center rounded-full bg-emerald-100 px-2 py-0.5 text-[0.68rem] font-medium text-emerald-700">
                                        {copy.ollamaTitle}
                                      </span>
                                    ) : null}
                                  </div>
                                  <span className="inline-flex min-w-8 items-center justify-center rounded-full bg-white/92 px-2 py-1 text-xs font-medium text-slate-500 shadow-[inset_0_1px_0_rgba(255,255,255,0.92)]">
                                    {entries.length}
                                  </span>
                                </div>
                                <div className="space-y-2 border-t border-white/80 bg-white/72 px-2.5 py-2.5">
                                  {entries.map((entry) => (
                                    <button
                                      key={entry.key}
                                      className={`${configListButtonClass} ${
                                        entry.key ===
                                        pendingOpenClawModelSelection
                                          ? configListButtonActiveClass
                                          : configListButtonInactiveClass
                                      }`}
                                      disabled={switchingModelKey !== null}
                                      onClick={() =>
                                        setPendingOpenClawModelSelection(
                                          entry.key,
                                        )
                                      }
                                      type="button"
                                    >
                                      <div className="min-w-0">
                                        <p className="truncate text-sm">
                                          {entry.modelId}
                                        </p>
                                        <p
                                          className={`truncate text-xs ${entry.key === pendingOpenClawModelSelection ? "text-[#007AFF]" : "text-slate-500"}`}
                                        >
                                          {entry.name}
                                        </p>
                                      </div>
                                      <div
                                        className={`text-right text-xs ${entry.key === pendingOpenClawModelSelection ? "text-[#007AFF]" : "text-slate-500"}`}
                                      >
                                        <p>{entry.input ?? "--"}</p>
                                        <p>{entry.contextWindow ?? "--"}</p>
                                      </div>
                                    </button>
                                  ))}
                                </div>
                              </div>
                            ),
                          )
                        )}
                      </div>

                      <div className="mt-4 flex justify-end">
                        <button
                          aria-label={copy.save}
                          className={compactConfirmIconButtonClass}
                          disabled={
                            pendingOpenClawModelSelection.trim().length === 0 ||
                            pendingOpenClawModelSelection ===
                              (currentOpenClawModel?.key ?? "") ||
                            switchingModelKey !== null
                          }
                          onClick={() =>
                            void handleSavePendingOpenClawModelSelection()
                          }
                          title={copy.save}
                          type="button"
                        >
                          {switchingModelKey !== null ? (
                            <SpinnerIcon />
                          ) : (
                            <CheckIcon />
                          )}
                        </button>
                      </div>
                    </section>
                  </div>
                ) : null}

                {configPage === "skill" ? (
                  <div className="space-y-4">
                    <div className="space-y-3 px-1 pt-1">
                      <button
                        aria-label={copy.configCenterBackAriaLabel}
                        className={configBackButtonClass}
                        onClick={() => setConfigPage(null)}
                        type="button"
                      >
                        <ChevronLeftIcon />
                      </button>
                      <div className="flex items-center gap-2 text-base text-slate-400">
                        <button
                          className="transition hover:text-slate-700"
                          onClick={() => setConfigPage(null)}
                          type="button"
                        >
                          {copy.configCenterBreadcrumb}
                        </button>
                        <span>/</span>
                        <span className="text-slate-600">
                          {copy.skillManagementTitle}
                        </span>
                      </div>
                      <p className="mt-1 text-xs text-slate-500">
                        {copy.skillManagementDescription}
                      </p>
                    </div>

                    <section className="rounded-3xl border border-white/85 bg-white/70 p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.9)] backdrop-blur-xl">
                      <div className="space-y-3">
                        <div className="flex items-center justify-between gap-3 rounded-[1rem] border border-slate-200/80 bg-slate-50/80 px-4 py-3">
                          <div>
                            <p className="text-sm font-semibold text-slate-950">
                              {copy.installedSkillsTitle}
                            </p>
                            <p className="mt-1 text-xs text-slate-500">
                              {copy.installedSkillsSummary(
                                installedSkills.length,
                              )}
                            </p>
                          </div>
                          <div className="flex items-center gap-2">
                            <button
                              className={configAddIconButtonClass}
                              disabled={isOpeningClawhubMarketplace}
                              onClick={() =>
                                void handleOpenClawhubMarketplace()
                              }
                              title={copy.openSkillCatalog}
                              type="button"
                            >
                              {isOpeningClawhubMarketplace ? (
                                <SpinnerIcon />
                              ) : (
                                <PlusIcon />
                              )}
                            </button>
                            <button
                              className={configAddIconButtonClass}
                              disabled={isSkillListLoading}
                              onClick={() => void loadInstalledSkills()}
                              title={copy.refreshSkillList}
                              type="button"
                            >
                              {isSkillListLoading ? (
                                <SpinnerIcon />
                              ) : (
                                <RefreshIcon />
                              )}
                            </button>
                          </div>
                        </div>

                        {isSkillListLoading ? (
                          <p className="text-sm text-slate-500">
                            {copy.loadingSkillList}
                          </p>
                        ) : installedSkillsBySource.length === 0 ? (
                          <p className="text-sm text-slate-500">
                            {copy.installedSkillsEmpty}
                          </p>
                        ) : (
                          installedSkillsBySource.map(([source, entries]) => (
                            <div
                              key={source}
                              className="overflow-hidden rounded-[1.35rem] border border-white/85 bg-[linear-gradient(180deg,rgba(248,250,252,0.96),rgba(255,255,255,0.9))] shadow-[0_14px_34px_rgba(15,23,42,0.06),inset_0_1px_0_rgba(255,255,255,0.92)]"
                            >
                              <button
                                className="flex w-full items-center justify-between gap-3 px-3 py-3 text-left"
                                onClick={() =>
                                  setCollapsedSkillSources((current) => ({
                                    ...current,
                                    [source]: !current[source],
                                  }))
                                }
                                type="button"
                              >
                                <div className="flex min-w-0 items-center gap-2">
                                  <p className="min-w-0 truncate text-sm font-semibold text-slate-900">
                                    {source === "workspace"
                                      ? copy.skillSourceWorkspace
                                      : source === "managed"
                                        ? copy.skillSourceManaged
                                        : copy.skillSourceBundled}
                                  </p>
                                  <span className="inline-flex items-center rounded-full bg-white/92 px-2 py-0.5 text-[0.68rem] font-medium text-slate-500 shadow-[inset_0_1px_0_rgba(255,255,255,0.92)]">
                                    {source}
                                  </span>
                                </div>
                                <div className="flex items-center gap-2">
                                  <span className="inline-flex min-w-8 items-center justify-center rounded-full bg-white/92 px-2 py-1 text-xs font-medium text-slate-500 shadow-[inset_0_1px_0_rgba(255,255,255,0.92)]">
                                    {entries.length}
                                  </span>
                                  <span className="text-slate-400">
                                    {collapsedSkillSources[source] ? (
                                      <ChevronRightIcon />
                                    ) : (
                                      <ChevronLeftDownIcon />
                                    )}
                                  </span>
                                </div>
                              </button>
                              {collapsedSkillSources[source] ? null : (
                                <div className="space-y-2 border-t border-white/80 bg-white/72 px-2.5 py-2.5">
                                  {entries.map((entry) => (
                                    <div
                                      key={`${entry.source}:${entry.id}`}
                                      className="rounded-[1rem] border border-slate-200 bg-white px-3 py-3"
                                    >
                                      <div className="flex items-start justify-between gap-3">
                                        <div className="min-w-0">
                                          <p className="truncate text-sm font-semibold text-slate-900">
                                            {entry.title}
                                          </p>
                                          <p className="mt-1 truncate text-xs text-slate-500">
                                            {entry.skillKey}
                                          </p>
                                        </div>
                                        <div className="flex shrink-0 items-center gap-2">
                                          <span
                                            className={`inline-flex items-center rounded-full px-2 py-0.5 text-[0.68rem] font-medium ${
                                              entry.enabled
                                                ? "bg-emerald-100 text-emerald-700"
                                                : "bg-slate-200 text-slate-600"
                                            }`}
                                          >
                                            {entry.enabled
                                              ? copy.skillEnabled
                                              : copy.skillDisabled}
                                          </span>
                                          <button
                                            aria-checked={entry.enabled}
                                            aria-label={
                                              entry.enabled
                                                ? copy.disableSkill
                                                : copy.enableSkill
                                            }
                                            className={`relative inline-flex h-6 w-10 shrink-0 items-center rounded-full transition-all duration-200 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50 ${
                                              entry.enabled
                                                ? "bg-emerald-500 shadow-[0_10px_24px_rgba(16,185,129,0.22)] hover:bg-emerald-600"
                                                : "bg-slate-300 hover:bg-slate-400"
                                            }`}
                                            disabled={
                                              togglingSkillKey ===
                                              entry.skillKey
                                            }
                                            onClick={() =>
                                              void handleToggleSkillEnabled(
                                                entry.skillKey,
                                                !entry.enabled,
                                              )
                                            }
                                            role="switch"
                                            type="button"
                                          >
                                            <span
                                              aria-hidden="true"
                                              className={`inline-block h-4 w-4 rounded-full bg-white shadow-[0_4px_10px_rgba(15,23,42,0.18)] transition-transform duration-200 ${
                                                entry.enabled
                                                  ? "translate-x-5"
                                                  : "translate-x-1"
                                              }`}
                                            >
                                              {togglingSkillKey ===
                                              entry.skillKey ? (
                                                <span className="flex h-full w-full items-center justify-center text-slate-400">
                                                  <SpinnerIcon />
                                                </span>
                                              ) : null}
                                            </span>
                                          </button>
                                          {source === "workspace" ? (
                                            <button
                                              className={dangerIconButtonClass}
                                              disabled={
                                                removingWorkspaceSkillSlug ===
                                                entry.id
                                              }
                                              onClick={() =>
                                                setPendingWorkspaceSkillRemoval(
                                                  entry.id,
                                                )
                                              }
                                              title={copy.deleteSkill}
                                              type="button"
                                            >
                                              {removingWorkspaceSkillSlug ===
                                              entry.id ? (
                                                <SpinnerIcon />
                                              ) : (
                                                <DeleteIcon />
                                              )}
                                            </button>
                                          ) : null}
                                        </div>
                                      </div>
                                      <div className="mt-2 flex flex-wrap items-center gap-1.5">
                                        {entry.hasReferences ? (
                                          <span className="inline-flex items-center rounded-full bg-sky-100 px-2 py-0.5 text-[0.68rem] font-medium text-sky-700">
                                            references
                                          </span>
                                        ) : null}
                                        {entry.hasScripts ? (
                                          <span className="inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-[0.68rem] font-medium text-amber-700">
                                            scripts
                                          </span>
                                        ) : null}
                                      </div>
                                      {entry.description ? (
                                        <p className="mt-2 text-xs leading-5 text-slate-600">
                                          {entry.description}
                                        </p>
                                      ) : null}
                                      <p className="mt-2 break-all text-[0.7rem] leading-5 text-slate-400">
                                        {entry.path}
                                      </p>
                                    </div>
                                  ))}
                                </div>
                              )}
                            </div>
                          ))
                        )}
                      </div>
                    </section>
                  </div>
                ) : null}
              </div>
            ) : null}

            {mainNav === "logs" ? (
              <div className="flex h-full min-h-0 flex-col rounded-3xl border border-white/85 bg-white/70 p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.9)] backdrop-blur-xl">
                <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <button
                      className={`${tertiaryButtonClass} ${selectedLogSource === "launcher" ? "border-[#007AFF]/35 text-[#007AFF]" : ""}`}
                      onClick={() => setSelectedLogSource("launcher")}
                      type="button"
                    >
                      {copy.logSourceLauncher}
                    </button>
                    {supportsLocalModels ? (
                      <button
                        className={`${tertiaryButtonClass} ${selectedLogSource === "ollama" ? "border-[#007AFF]/35 text-[#007AFF]" : ""}`}
                        onClick={() => setSelectedLogSource("ollama")}
                        type="button"
                      >
                        {copy.logSourceOllama}
                      </button>
                    ) : null}
                    <button
                      className={`${tertiaryButtonClass} ${selectedLogSource === "gateway" ? "border-[#007AFF]/35 text-[#007AFF]" : ""}`}
                      onClick={() => setSelectedLogSource("gateway")}
                      type="button"
                    >
                      {copy.logSourceGateway}
                    </button>
                  </div>
                  <div className="flex items-center gap-2 text-xs text-slate-500">
                    <span>{copy.logsAutoRefresh}</span>
                    <button
                      className={tertiaryButtonClass}
                      onClick={() => {
                        shouldStickLogsToBottomRef.current = true;
                        syncLogsScrollPosition();
                      }}
                      type="button"
                    >
                      {copy.logsJumpToLatest}
                    </button>
                  </div>
                </div>
                {isLogsLoading ? (
                  <p className="text-sm text-slate-600">{copy.loading}</p>
                ) : launcherLogs.trim().length > 0 ? (
                  <pre
                    ref={logsContainerRef}
                    className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words rounded-2xl bg-slate-950 p-4 text-xs leading-6 text-slate-100"
                    onScroll={(event) => {
                      const element = event.currentTarget;
                      const distanceToBottom =
                        element.scrollHeight -
                        element.scrollTop -
                        element.clientHeight;
                      shouldStickLogsToBottomRef.current =
                        distanceToBottom < 24;
                    }}
                  >
                    {launcherLogs}
                  </pre>
                ) : (
                  <p className="text-sm text-slate-600">
                    {statusMessage || copy.pending}
                  </p>
                )}
              </div>
            ) : null}
          </section>
        </div>
        <p className="pl-4 text-left text-[0.72rem] leading-5 text-slate-500 sm:pl-5">
          {copy.brandSlogan(openclawVersion)}
        </p>
      </div>

      {isResetConfirmOpen ? (
        <div className={modalOverlayClass}>
          <section className={`w-full max-w-sm ${modalPanelClass}`}>
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-lg font-semibold text-slate-950">
                {copy.resetConfirmAction}
              </h3>
              <button
                className={closeIconButtonClass}
                disabled={isResettingOpenClaw}
                onClick={() => setIsResetConfirmOpen(false)}
                title={copy.close}
                type="button"
              >
                <CloseIcon />
              </button>
            </div>

            <p className="mt-4 text-sm leading-6 text-slate-600">
              {copy.resetConfirmMessage}
            </p>

            <div className="mt-5 flex items-center justify-end gap-2">
              <button
                className={tertiaryButtonClass}
                disabled={isResettingOpenClaw}
                onClick={() => setIsResetConfirmOpen(false)}
                type="button"
              >
                {copy.no}
              </button>
              <button
                className="cursor-pointer rounded-xl bg-[#007AFF] px-3 py-2 text-xs font-semibold text-white shadow-[0_10px_24px_rgba(0,122,255,0.28)] transition-all duration-200 hover:bg-[#006AE6] active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
                disabled={isResettingOpenClaw}
                onClick={() => void handleResetOpenClawConfig()}
                type="button"
              >
                {isResettingOpenClaw
                  ? copy.resettingOpenClaw
                  : copy.resetConfirmAction}
              </button>
            </div>
          </section>
        </div>
      ) : null}

      {isSetupConfirmOpen ? (
        <div className={modalOverlayClass}>
          <section className={`w-full max-w-sm ${modalPanelClass}`}>
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-lg font-semibold text-slate-950">
                {copy.setupConfirmTitle}
              </h3>
              <button
                className={closeIconButtonClass}
                disabled={isOpeningSetup}
                onClick={() => setIsSetupConfirmOpen(false)}
                title={copy.close}
                type="button"
              >
                <CloseIcon />
              </button>
            </div>

            <p className="mt-4 text-sm leading-6 text-slate-600">
              {copy.setupConfirmMessage}
            </p>

            <div className="mt-5 flex items-center justify-end gap-2">
              <button
                className={tertiaryButtonClass}
                disabled={isOpeningSetup}
                onClick={() => setIsSetupConfirmOpen(false)}
                type="button"
              >
                {copy.no}
              </button>
              <button
                className="cursor-pointer rounded-xl bg-[#007AFF] px-3 py-2 text-xs font-semibold text-white shadow-[0_10px_24px_rgba(0,122,255,0.28)] transition-all duration-200 hover:bg-[#006AE6] active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
                disabled={isOpeningSetup}
                onClick={() => void handleOpenSetup()}
                type="button"
              >
                {isOpeningSetup ? copy.openingSetup : copy.openSetup}
              </button>
            </div>
          </section>
        </div>
      ) : null}

      {isChannelAddConfirmOpen ? (
        <div className={modalOverlayClass}>
          <section className={`w-full max-w-sm ${modalPanelClass}`}>
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-lg font-semibold text-slate-950">
                {copy.channelManagerAddConfirmTitle}
              </h3>
              <button
                className={closeIconButtonClass}
                disabled={isOpeningChannelWizard}
                onClick={() => setIsChannelAddConfirmOpen(false)}
                title={copy.close}
                type="button"
              >
                <CloseIcon />
              </button>
            </div>

            <p className="mt-4 text-sm leading-6 text-slate-600">
              {copy.channelManagerAddConfirmMessage}
            </p>

            <div className="mt-5 flex items-center justify-end gap-2">
              <button
                className={tertiaryButtonClass}
                disabled={isOpeningChannelWizard}
                onClick={() => setIsChannelAddConfirmOpen(false)}
                type="button"
              >
                {copy.no}
              </button>
              <button
                className="cursor-pointer rounded-xl bg-[#007AFF] px-3 py-2 text-xs font-semibold text-white shadow-[0_10px_24px_rgba(0,122,255,0.28)] transition-all duration-200 hover:bg-[#006AE6] active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
                disabled={isOpeningChannelWizard}
                onClick={() => void handleOpenChannelAddWizard()}
                type="button"
              >
                {isOpeningChannelWizard ? copy.pending : copy.channelManagerAdd}
              </button>
            </div>
          </section>
        </div>
      ) : null}

      {isModelProviderAddConfirmOpen ? (
        <div className={modalOverlayClass}>
          <section className={`w-full max-w-sm ${modalPanelClass}`}>
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-lg font-semibold text-slate-950">
                {copy.modelManagerAddConfirmTitle}
              </h3>
              <button
                className={closeIconButtonClass}
                disabled={isOpeningModelProviderWizard}
                onClick={() => setIsModelProviderAddConfirmOpen(false)}
                title={copy.close}
                type="button"
              >
                <CloseIcon />
              </button>
            </div>

            <p className="mt-4 text-sm leading-6 text-slate-600">
              {copy.modelManagerAddConfirmMessage}
            </p>

            <div className="mt-5 flex items-center justify-end gap-2">
              <button
                className={tertiaryButtonClass}
                disabled={isOpeningModelProviderWizard}
                onClick={() => setIsModelProviderAddConfirmOpen(false)}
                type="button"
              >
                {copy.no}
              </button>
              <button
                className="cursor-pointer rounded-xl bg-[#007AFF] px-3 py-2 text-xs font-semibold text-white shadow-[0_10px_24px_rgba(0,122,255,0.28)] transition-all duration-200 hover:bg-[#006AE6] active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
                disabled={isOpeningModelProviderWizard}
                onClick={() => void handleOpenModelProviderAddWizard()}
                type="button"
              >
                {isOpeningModelProviderWizard
                  ? copy.pending
                  : copy.modelManagerAddProvider}
              </button>
            </div>
          </section>
        </div>
      ) : null}

      {isLanguageSheetOpen ? (
        <div className={modalOverlayClass}>
          <section
            className={`w-full max-w-sm ${modalPanelClass}`}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="text-lg font-semibold text-slate-950">
                  {copy.languageSheetTitle}
                </h3>
                <p className="mt-1 text-sm leading-6 text-slate-500">
                  {copy.languageSheetDescription}
                </p>
              </div>
              <button
                className={closeIconButtonClass}
                disabled={isSaving}
                onClick={() => setIsLanguageSheetOpen(false)}
                title={copy.close}
                type="button"
              >
                <CloseIcon />
              </button>
            </div>

            <div className="mt-5 grid gap-3">
              {copy.languages.map((language) => {
                const active = selectedLanguage === language.code;
                return (
                  <button
                    key={language.code}
                    className={`${choiceButtonClass} w-full rounded-[1.25rem] px-5 py-4 text-left text-base ${
                      active
                        ? choiceButtonActiveClass
                        : "border-slate-300/80 bg-white/80 text-slate-950 hover:border-slate-500"
                    }`}
                    disabled={isSaving}
                    onClick={() =>
                      void handleChangeLanguageFromSheet(language.code)
                    }
                    type="button"
                    title={active ? copy.selected : undefined}
                  >
                    <span>{language.label}</span>
                  </button>
                );
              })}
            </div>

            {isSaving ? (
              <p className="mt-4 text-sm text-slate-500">{copy.saving}</p>
            ) : null}
          </section>
        </div>
      ) : null}

      {isStopLocalDownloadConfirmOpen ? (
        <div className={modalOverlayClass}>
          <section className={`w-full max-w-sm ${modalPanelClass}`}>
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-lg font-semibold text-slate-950">
                {copy.stopDownload}
              </h3>
              <button
                className={closeIconButtonClass}
                onClick={() => setIsStopLocalDownloadConfirmOpen(false)}
                title={copy.close}
                type="button"
              >
                <CloseIcon />
              </button>
            </div>

            <p className="mt-4 text-sm leading-6 text-slate-600">
              {copy.stopDownloadConfirm}
            </p>

            <div className="mt-5 flex items-center justify-end gap-2">
              <button
                className={tertiaryButtonClass}
                disabled={isStoppingLocalDownload}
                onClick={() => setIsStopLocalDownloadConfirmOpen(false)}
                type="button"
              >
                {copy.modelPickerCancelAdd}
              </button>
              <button
                className={dangerSubtleButtonClass}
                disabled={isStoppingLocalDownload}
                onClick={() => void handleStopLocalDownload()}
                type="button"
              >
                {isStoppingLocalDownload ? copy.pending : copy.confirmStop}
              </button>
            </div>
          </section>
        </div>
      ) : null}

      {pendingLocalModelToggleAction !== null ? (
        <div className={modalOverlayClass}>
          <section className={`w-full max-w-sm ${modalPanelClass}`}>
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-lg font-semibold text-slate-950">
                {copy.localModelToggleLabel}
              </h3>
              <button
                className={closeIconButtonClass}
                disabled={
                  pendingLocalModelToggleAction === "enable" && isStartingOllama
                }
                onClick={() => setPendingLocalModelToggleAction(null)}
                title={copy.close}
                type="button"
              >
                <CloseIcon />
              </button>
            </div>

            <p className="mt-4 text-sm leading-6 text-slate-600">
              {pendingLocalModelToggleAction === "enable" && isStartingOllama
                ? copy.startingOllama
                : pendingLocalModelToggleAction === "enable"
                  ? copy.localModelToggleEnableConfirm
                  : copy.localModelToggleDisableConfirm}
            </p>

            {pendingLocalModelToggleAction === "enable" && statusMessage ? (
              <p className="mt-3 rounded-2xl border border-red-200 bg-red-50 px-3 py-2 text-sm leading-6 text-red-600">
                {statusMessage}
              </p>
            ) : null}

            <div className="mt-5 flex items-center justify-end gap-2">
              <button
                className={tertiaryButtonClass}
                disabled={
                  isSavingLocalModelSelection ||
                  (pendingLocalModelToggleAction === "enable" &&
                    isStartingOllama)
                }
                onClick={() => setPendingLocalModelToggleAction(null)}
                type="button"
              >
                {copy.no}
              </button>
              <button
                className="cursor-pointer rounded-xl bg-[#007AFF] px-3 py-2 text-xs font-semibold text-white shadow-[0_10px_24px_rgba(0,122,255,0.28)] transition-all duration-200 hover:bg-[#006AE6] active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
                disabled={
                  isSavingLocalModelSelection ||
                  (pendingLocalModelToggleAction === "enable" &&
                    isStartingOllama)
                }
                onClick={() => void handleConfirmLocalModelToggle()}
                type="button"
              >
                {pendingLocalModelToggleAction === "enable" && isStartingOllama
                  ? copy.startingOllama
                  : pendingLocalModelToggleAction === "enable"
                    ? copy.localModelToggleTurnOn
                    : copy.localModelToggleGoCloud}
              </button>
            </div>
          </section>
        </div>
      ) : null}

      {pendingWorkspaceSkillRemoval ? (
        <div className={modalOverlayClass}>
          <section className={`w-full max-w-sm ${modalPanelClass}`}>
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-lg font-semibold text-slate-950">
                {copy.removeSkillTitle}
              </h3>
              <button
                className={closeIconButtonClass}
                disabled={removingWorkspaceSkillSlug !== null}
                onClick={() => setPendingWorkspaceSkillRemoval(null)}
                title={copy.close}
                type="button"
              >
                <CloseIcon />
              </button>
            </div>

            <p className="mt-4 text-sm leading-6 text-slate-600">
              {copy.removeWorkspaceSkillConfirm(pendingWorkspaceSkillRemoval)}
            </p>

            <div className="mt-5 flex items-center justify-end gap-2">
              <button
                className={tertiaryButtonClass}
                disabled={removingWorkspaceSkillSlug !== null}
                onClick={() => setPendingWorkspaceSkillRemoval(null)}
                type="button"
              >
                {copy.modelPickerCancelAdd}
              </button>
              <button
                className={dangerSubtleButtonClass}
                disabled={removingWorkspaceSkillSlug !== null}
                onClick={() => void handleConfirmRemoveWorkspaceSkill()}
                type="button"
              >
                {removingWorkspaceSkillSlug !== null
                  ? copy.removing
                  : copy.confirmDelete}
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </main>
  );
}

function describeError(error: unknown, fallback: string) {
  if (typeof error === "string" && error.trim().length > 0) return error;
  if (error instanceof Error && error.message.trim().length > 0)
    return error.message;
  if (typeof error === "object" && error !== null) {
    const message = Reflect.get(error, "message");
    if (typeof message === "string" && message.trim().length > 0)
      return message;
  }

  return fallback;
}

function isLocalModelRunAlreadyInProgressError(error: unknown) {
  return (
    describeError(error, "") === "a local model run task is already in progress"
  );
}

function serializeErrorForLog(error: unknown) {
  if (typeof error === "string") {
    return { type: "string", value: error };
  }
  if (error instanceof Error) {
    return {
      type: error.name || "Error",
      message: error.message,
      stack: error.stack ?? null,
    };
  }
  if (typeof error === "object" && error !== null) {
    const message = Reflect.get(error, "message");
    const name = Reflect.get(error, "name");
    let serializedValue = null;
    try {
      serializedValue = JSON.parse(JSON.stringify(error));
    } catch {
      serializedValue = String(error);
    }
    return {
      type: typeof name === "string" && name.trim() ? name : "object",
      message: typeof message === "string" ? message : null,
      value: serializedValue,
    };
  }
  return { type: typeof error, value: error ?? null };
}

function looksLikeCloudModelName(model: string) {
  const normalized = model.trim().toLowerCase();
  if (normalized.length === 0) return false;

  const separatorIndex = normalized.lastIndexOf(":");
  const repository =
    separatorIndex >= 0 ? normalized.slice(0, separatorIndex) : normalized;
  const tag = separatorIndex >= 0 ? normalized.slice(separatorIndex + 1) : "";

  return (
    repository.endsWith("-cloud") || tag === "cloud" || tag.endsWith("-cloud")
  );
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let amount = value;
  let unitIndex = 0;
  while (amount >= 1024 && unitIndex < units.length - 1) {
    amount /= 1024;
    unitIndex += 1;
  }
  return `${amount >= 10 ? amount.toFixed(1) : amount.toFixed(2)} ${units[unitIndex]}`;
}

function formatTransferInfo(progress: LocalModelRunProgress): string {
  const fromMetrics =
    progress.completedBytes !== null && progress.totalBytes !== null
      ? `${formatBytes(progress.completedBytes)}/${formatBytes(progress.totalBytes)}${
          progress.speedBytesPerSec !== null
            ? ` ${formatBytes(progress.speedBytesPerSec)}/S`
            : ""
        }`
      : "";

  if (fromMetrics.trim().length > 0) return fromMetrics;

  const extracted = extractTransferInfoFromMessage(progress.message);
  return extracted ?? "";
}

function extractTransferInfoFromMessage(message: string): string | null {
  const pattern =
    /(\d+(?:\.\d+)?\s*[KMGTP]?B\s*\/\s*\d+(?:\.\d+)?\s*[KMGTP]?B(?:\s+\d+(?:\.\d+)?\s*[KMGTP]?B\/S)?)/i;
  const match = message.match(pattern);
  if (!match?.[1]) return null;
  return match[1].replace(/\s+/g, " ").trim();
}

const appFrameClass =
  "box-border flex min-h-dvh items-center justify-center overflow-hidden bg-transparent px-4 py-4 text-slate-900 sm:px-5 sm:py-5 lg:px-6 lg:py-6";

const onboardingCardClass =
  "rounded-3xl border border-white/75 bg-white/66 p-6 shadow-[0_18px_48px_rgba(15,23,42,0.12),inset_0_1px_0_rgba(255,255,255,0.85)] backdrop-blur-2xl sm:p-8";

const titleClass =
  "text-center text-[1.8rem] font-semibold tracking-[-0.03em] text-slate-950 sm:text-[2.1rem]";

const bodyTextClass = "text-sm leading-6 text-slate-600";

const formLabelClass = "block text-sm font-medium text-slate-700";

const inputClass =
  "w-full rounded-2xl border border-white/85 bg-white/78 px-4 py-3 text-sm text-slate-900 shadow-[inset_0_1px_0_rgba(255,255,255,0.95)] outline-none backdrop-blur transition duration-200 focus:border-[#007AFF]/50 focus:ring-2 focus:ring-[#007AFF]/20";

const choiceButtonClass =
  "cursor-pointer rounded-2xl border px-4 py-3 text-sm font-semibold transition-all duration-200 active:scale-95 disabled:cursor-not-allowed disabled:opacity-50";

const choiceButtonActiveClass =
  "border-[#007AFF] bg-[#007AFF] text-white shadow-[0_10px_24px_rgba(0,122,255,0.28)]";

const choiceButtonInactiveClass =
  "border-white/85 bg-white/72 text-slate-900 hover:border-[#007AFF]/40 hover:bg-white/88";

const modalOverlayClass =
  "fixed inset-0 z-50 flex items-center justify-center bg-slate-950/20 backdrop-blur-sm px-4 py-6";

const modalPanelClass =
  "rounded-3xl border border-white/80 bg-white/78 p-4 shadow-[0_24px_80px_rgba(15,23,42,0.18),inset_0_1px_0_rgba(255,255,255,0.85)] backdrop-blur-2xl sm:p-5";

const closeIconButtonClass =
  "inline-flex h-8 w-8 cursor-pointer items-center justify-center rounded-full border border-white/85 bg-white/72 text-slate-600 transition-all duration-200 hover:border-[#007AFF]/35 hover:text-[#007AFF] active:scale-95";

const secondaryButtonClass =
  "cursor-pointer rounded-2xl border border-white/90 bg-white/78 px-4 py-3 text-sm font-semibold text-slate-800 shadow-[inset_0_1px_0_rgba(255,255,255,0.95)] backdrop-blur transition-all duration-200 hover:border-[#007AFF]/35 hover:text-[#007AFF] active:scale-95 disabled:cursor-not-allowed disabled:opacity-50";

const tertiaryButtonClass =
  "cursor-pointer rounded-xl border border-white/90 bg-white/78 px-3 py-2 text-xs font-semibold text-slate-700 backdrop-blur transition-all duration-200 hover:border-[#007AFF]/35 hover:text-[#007AFF] active:scale-95 disabled:cursor-not-allowed disabled:opacity-50";

const dangerSubtleButtonClass =
  "cursor-pointer rounded-xl border border-rose-200/80 bg-rose-50/85 px-3 py-1.5 text-xs font-semibold text-rose-700 transition-all duration-200 hover:border-rose-300 hover:bg-rose-100 active:scale-95 disabled:cursor-not-allowed disabled:opacity-50";

const iconButtonClass =
  "inline-flex h-11 w-11 cursor-pointer items-center justify-center rounded-full bg-white/55 text-slate-700 backdrop-blur transition-all duration-200 hover:bg-white/80 hover:text-[#007AFF] active:scale-95 disabled:cursor-not-allowed disabled:opacity-35";

const sideNavButtonClass =
  "flex w-full cursor-pointer items-center gap-2 rounded-2xl px-3 py-2 text-left text-sm font-medium transition-all duration-200 active:scale-95";

const sideNavButtonActiveClass = "bg-white text-[#007AFF]";

const sideNavButtonInactiveClass =
  "text-slate-700 hover:bg-white/65 hover:text-slate-950";

const bottomNavIconButtonClass =
  "inline-flex h-9 w-9 cursor-pointer items-center justify-center rounded-xl border border-transparent bg-white/70 text-slate-700 transition-all duration-200 hover:bg-white hover:text-[#007AFF] active:scale-95 disabled:cursor-not-allowed disabled:opacity-50";

const configEntryCardClass =
  "flex w-full items-center justify-between gap-4 rounded-[1.5rem] border border-white/90 bg-white/78 px-4 py-4 text-left shadow-[0_12px_28px_rgba(15,23,42,0.07),inset_0_1px_0_rgba(255,255,255,0.92)] backdrop-blur-xl transition-all duration-200 hover:border-[#007AFF]/35 hover:bg-white/92 hover:shadow-[0_16px_38px_rgba(15,23,42,0.1),inset_0_1px_0_rgba(255,255,255,0.96)] active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-50";

const configBackButtonClass =
  "inline-flex h-10 w-10 items-center justify-center self-start rounded-full border border-white/90 bg-white/76 text-slate-700 shadow-[0_8px_20px_rgba(15,23,42,0.06),inset_0_1px_0_rgba(255,255,255,0.92)] backdrop-blur transition-all duration-200 hover:border-[#007AFF]/35 hover:text-[#007AFF] active:scale-[0.98]";

const configListButtonClass =
  "flex w-full items-center justify-between gap-3 rounded-[1rem] border px-3.5 py-3 text-left text-sm shadow-[inset_0_1px_0_rgba(255,255,255,0.92)] transition-all duration-200 disabled:cursor-not-allowed disabled:opacity-50";

const configListButtonActiveClass =
  "border-[#007AFF]/28 bg-white text-[#007AFF] shadow-[0_10px_24px_rgba(0,122,255,0.08),inset_0_1px_0_rgba(255,255,255,0.94)]";

const configListButtonInactiveClass =
  "border-slate-200/75 bg-white/96 text-slate-900 hover:border-[#007AFF]/20 hover:bg-[#007AFF]/[0.035] hover:shadow-[0_10px_24px_rgba(15,23,42,0.05),inset_0_1px_0_rgba(255,255,255,0.96)]";

const configAddIconButtonClass =
  "inline-flex h-8 w-8 items-center justify-center rounded-full bg-[#007AFF] text-white shadow-[0_8px_18px_rgba(0,122,255,0.22)] transition-all duration-200 hover:bg-[#006AE6] active:scale-[0.98]";

const dangerIconButtonClass =
  "inline-flex h-8 w-8 items-center justify-center rounded-full border border-rose-200/80 bg-white/88 text-rose-600 shadow-[0_8px_18px_rgba(15,23,42,0.06)] transition-all duration-200 hover:border-rose-300 hover:bg-rose-50 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50";

const compactPrimaryIconButtonClass =
  "inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#007AFF] text-white shadow-[0_8px_18px_rgba(0,122,255,0.2)] transition-all duration-200 hover:bg-[#006AE6] active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50";

const compactConfirmIconButtonClass =
  "inline-flex h-8 w-8 items-center justify-center rounded-full bg-[#007AFF] text-white shadow-[0_8px_18px_rgba(0,122,255,0.2)] transition-all duration-200 hover:bg-[#006AE6] active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50";

const compactInputClass =
  "h-9 w-full rounded-2xl border border-white/85 bg-white/78 px-4 text-sm text-slate-900 shadow-[inset_0_1px_0_rgba(255,255,255,0.95)] outline-none backdrop-blur transition duration-200 focus:border-[#007AFF]/50 focus:ring-2 focus:ring-[#007AFF]/20";

function ChevronLeftIcon() {
  return (
    <svg aria-hidden="true" className="h-5 w-5" fill="none" viewBox="0 0 24 24">
      <path
        d="M14 6L8 12L14 18"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.9"
      />
    </svg>
  );
}

function ChevronRightIcon() {
  return (
    <svg aria-hidden="true" className="h-5 w-5" fill="none" viewBox="0 0 24 24">
      <path
        d="M10 6L16 12L10 18"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.9"
      />
    </svg>
  );
}

function ChevronForwardIcon() {
  return (
    <svg aria-hidden="true" className="h-5 w-5" fill="none" viewBox="0 0 24 24">
      <path
        d="M9 5L16 12L9 19"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2"
      />
    </svg>
  );
}

function ChevronLeftDownIcon() {
  return (
    <svg aria-hidden="true" className="h-5 w-5" fill="none" viewBox="0 0 24 24">
      <path
        d="M6 9L12 15L18 9"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2"
      />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg aria-hidden="true" className="h-4 w-4" fill="none" viewBox="0 0 24 24">
      <path
        d="M12 5V19"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="2"
      />
      <path
        d="M5 12H19"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="2"
      />
    </svg>
  );
}

function DownloadIcon() {
  return (
    <svg aria-hidden="true" className="h-4 w-4" fill="none" viewBox="0 0 24 24">
      <path
        d="M12 5V14"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="2"
      />
      <path
        d="M8.5 10.5L12 14L15.5 10.5"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2"
      />
      <path
        d="M6 18H18"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="2"
      />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg aria-hidden="true" className="h-4 w-4" fill="none" viewBox="0 0 24 24">
      <path
        d="M6 12.5L10 16.5L18 8.5"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2"
      />
    </svg>
  );
}

function SpinnerIcon() {
  return (
    <svg
      aria-hidden="true"
      className="h-4 w-4 animate-spin"
      fill="none"
      viewBox="0 0 24 24"
    >
      <circle
        cx="12"
        cy="12"
        r="8"
        opacity="0.25"
        stroke="currentColor"
        strokeWidth="2"
      />
      <path
        d="M20 12A8 8 0 0 0 12 4"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="2"
      />
    </svg>
  );
}

function RefreshIcon() {
  return (
    <svg aria-hidden="true" className="h-4 w-4" fill="none" viewBox="0 0 24 24">
      <path
        d="M20 12A8 8 0 1 1 17.4 6.1"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.9"
      />
      <path
        d="M20 4V9H15"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.9"
      />
    </svg>
  );
}

function DeleteIcon() {
  return (
    <svg aria-hidden="true" className="h-4 w-4" fill="none" viewBox="0 0 24 24">
      <path
        d="M5 7H19"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1.8"
      />
      <path
        d="M9 7V5.5C9 4.95 9.45 4.5 10 4.5H14C14.55 4.5 15 4.95 15 5.5V7"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.8"
      />
      <path
        d="M8 9.5V17.5"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1.8"
      />
      <path
        d="M12 9.5V17.5"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1.8"
      />
      <path
        d="M16 9.5V17.5"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1.8"
      />
    </svg>
  );
}

function OverviewIcon() {
  return (
    <svg aria-hidden="true" className="h-4 w-4" fill="none" viewBox="0 0 24 24">
      <path
        d="M4 4H10V10H4V4Z"
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth="1.8"
      />
      <path
        d="M14 4H20V7H14V4Z"
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth="1.8"
      />
      <path
        d="M14 11H20V20H14V11Z"
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth="1.8"
      />
      <path
        d="M4 14H10V20H4V14Z"
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth="1.8"
      />
    </svg>
  );
}

function ConfigIcon() {
  return (
    <svg aria-hidden="true" className="h-4 w-4" fill="none" viewBox="0 0 24 24">
      <path
        d="M12 15.5C13.933 15.5 15.5 13.933 15.5 12C15.5 10.067 13.933 8.5 12 8.5C10.067 8.5 8.5 10.067 8.5 12C8.5 13.933 10.067 15.5 12 15.5Z"
        stroke="currentColor"
        strokeWidth="1.8"
      />
      <path
        d="M19.4 13.5V10.5L17.5 10.1C17.4 9.7 17.2 9.3 17 8.9L18.1 7.3L16 5.2L14.4 6.3C14 6.1 13.6 5.9 13.2 5.8L12.8 4H9.8L9.4 5.8C9 5.9 8.6 6.1 8.2 6.3L6.6 5.2L4.5 7.3L5.6 8.9C5.4 9.3 5.2 9.7 5.1 10.1L3.2 10.5V13.5L5.1 13.9C5.2 14.3 5.4 14.7 5.6 15.1L4.5 16.7L6.6 18.8L8.2 17.7C8.6 17.9 9 18.1 9.4 18.2L9.8 20H12.8L13.2 18.2C13.6 18.1 14 17.9 14.4 17.7L16 18.8L18.1 16.7L17 15.1C17.2 14.7 17.4 14.3 17.5 13.9L19.4 13.5Z"
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth="1.8"
      />
    </svg>
  );
}

function LocalModelConfigIcon() {
  return (
    <svg aria-hidden="true" className="h-5 w-5" fill="none" viewBox="0 0 24 24">
      <rect
        height="12"
        rx="2.5"
        stroke="currentColor"
        strokeWidth="1.8"
        width="16"
        x="4"
        y="6"
      />
      <path
        d="M9 10H15"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1.8"
      />
      <path
        d="M9 14H12"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1.8"
      />
      <path
        d="M2.5 9.5H4"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1.8"
      />
      <path
        d="M2.5 14.5H4"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1.8"
      />
      <path
        d="M20 9.5H21.5"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1.8"
      />
      <path
        d="M20 14.5H21.5"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1.8"
      />
    </svg>
  );
}

function LocalModelOverviewIcon() {
  return (
    <svg aria-hidden="true" className="h-5 w-5" fill="none" viewBox="0 0 24 24">
      <rect
        height="10"
        rx="2.5"
        stroke="currentColor"
        strokeWidth="1.8"
        width="14"
        x="5"
        y="7"
      />
      <path
        d="M9 12H15"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1.8"
      />
      <path
        d="M12 17V20"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1.8"
      />
      <path
        d="M9.5 20H14.5"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1.8"
      />
    </svg>
  );
}

function ChannelConfigIcon() {
  return (
    <svg aria-hidden="true" className="h-5 w-5" fill="none" viewBox="0 0 24 24">
      <path
        d="M7 18H6C4.9 18 4 17.1 4 16V8C4 6.9 4.9 6 6 6H18C19.1 6 20 6.9 20 8V16C20 17.1 19.1 18 18 18H11L7 21V18Z"
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth="1.8"
      />
      <path
        d="M8 10H16"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1.8"
      />
      <path
        d="M8 14H13"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1.8"
      />
    </svg>
  );
}

function CloudModelConfigIcon() {
  return (
    <svg aria-hidden="true" className="h-5 w-5" fill="none" viewBox="0 0 24 24">
      <path
        d="M7.5 18.5H17C19.2 18.5 21 16.7 21 14.5C21 12.46 19.47 10.78 17.5 10.53C16.97 7.97 14.7 6 12 6C9.23 6 6.91 8.08 6.46 10.75C4.99 11.29 4 12.7 4 14.3C4 16.6 5.82 18.5 8.1 18.5"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.8"
      />
      <path
        d="M12 11V18"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1.8"
      />
      <path
        d="M9.5 13.5L12 11L14.5 13.5"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.8"
      />
    </svg>
  );
}

function SkillConfigIcon() {
  return (
    <svg aria-hidden="true" className="h-5 w-5" fill="none" viewBox="0 0 24 24">
      <path
        d="M7 7H11V11H7V7Z"
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth="1.8"
      />
      <path
        d="M13 7H17V11H13V7Z"
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth="1.8"
      />
      <path
        d="M7 13H11V17H7V13Z"
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth="1.8"
      />
      <path
        d="M13 13H17V17H13V13Z"
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth="1.8"
      />
    </svg>
  );
}

function OpenClawOverviewIcon() {
  return (
    <svg aria-hidden="true" className="h-5 w-5" fill="none" viewBox="0 0 24 24">
      <path
        d="M7 9.5L12 6L17 9.5V15.5L12 19L7 15.5V9.5Z"
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth="1.8"
      />
      <path
        d="M12 6V12"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1.8"
      />
      <path
        d="M17 9.5L12 12L7 9.5"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.8"
      />
    </svg>
  );
}

function LogsIcon() {
  return (
    <svg aria-hidden="true" className="h-4 w-4" fill="none" viewBox="0 0 24 24">
      <path
        d="M6 5H18V19H6V5Z"
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth="1.8"
      />
      <path
        d="M9 9H15"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1.8"
      />
      <path
        d="M9 13H15"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1.8"
      />
    </svg>
  );
}

function MoreIcon() {
  return (
    <svg
      aria-hidden="true"
      className="h-4 w-4"
      fill="currentColor"
      viewBox="0 0 24 24"
    >
      <circle cx="5" cy="12" r="1.8" />
      <circle cx="12" cy="12" r="1.8" />
      <circle cx="19" cy="12" r="1.8" />
    </svg>
  );
}

function LanguageIcon() {
  return (
    <svg aria-hidden="true" className="h-4 w-4" fill="none" viewBox="0 0 24 24">
      <path
        d="M3 12H21"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1.8"
      />
      <path
        d="M12 3C14.5 5.7 16 8.9 16 12C16 15.1 14.5 18.3 12 21"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1.8"
      />
      <path
        d="M12 3C9.5 5.7 8 8.9 8 12C8 15.1 9.5 18.3 12 21"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1.8"
      />
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.8" />
    </svg>
  );
}

function SetupIcon() {
  return (
    <svg aria-hidden="true" className="h-4 w-4" fill="none" viewBox="0 0 24 24">
      <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.8" />
      <path
        d="M19 12C19 11.53 18.95 11.08 18.84 10.65L20.65 9.25L18.75 5.95L16.55 6.7C15.88 6.13 15.1 5.69 14.25 5.43L13.9 3H10.1L9.75 5.43C8.9 5.69 8.12 6.13 7.45 6.7L5.25 5.95L3.35 9.25L5.16 10.65C5.05 11.08 5 11.53 5 12C5 12.47 5.05 12.92 5.16 13.35L3.35 14.75L5.25 18.05L7.45 17.3C8.12 17.87 8.9 18.31 9.75 18.57L10.1 21H13.9L14.25 18.57C15.1 18.31 15.88 17.87 16.55 17.3L18.75 18.05L20.65 14.75L18.84 13.35C18.95 12.92 19 12.47 19 12Z"
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth="1.8"
      />
    </svg>
  );
}

function FileIcon() {
  return (
    <svg aria-hidden="true" className="h-4 w-4" fill="none" viewBox="0 0 24 24">
      <path
        d="M8 4.75H13.5L18 9.25V18C18 19.1 17.1 20 16 20H8C6.9 20 6 19.1 6 18V6.75C6 5.65 6.9 4.75 8 4.75Z"
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth="1.8"
      />
      <path
        d="M13 5V9.5H17.5"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.8"
      />
      <path
        d="M9 13H15"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1.8"
      />
      <path
        d="M9 16H13"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1.8"
      />
    </svg>
  );
}

function QqGroupIcon() {
  return (
    <svg aria-hidden="true" className="h-4 w-4" fill="none" viewBox="0 0 24 24">
      <path
        d="M12 7.5C13.38 7.5 14.5 6.38 14.5 5C14.5 3.62 13.38 2.5 12 2.5C10.62 2.5 9.5 3.62 9.5 5C9.5 6.38 10.62 7.5 12 7.5Z"
        stroke="currentColor"
        strokeWidth="1.8"
      />
      <path
        d="M8.5 13C8.5 10.79 10.07 9 12 9C13.93 9 15.5 10.79 15.5 13V15.5H8.5V13Z"
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth="1.8"
      />
      <path
        d="M7.5 18.5H16.5"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1.8"
      />
      <path
        d="M6 21.5H18"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1.8"
      />
    </svg>
  );
}

function TerminalIcon() {
  return (
    <svg aria-hidden="true" className="h-4 w-4" fill="none" viewBox="0 0 24 24">
      <path
        d="M4 6H20V18H4V6Z"
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth="1.8"
      />
      <path
        d="M7.5 10L10.5 12L7.5 14"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.8"
      />
      <path
        d="M12.5 14H16.5"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1.8"
      />
    </svg>
  );
}

function WebsiteIcon() {
  return (
    <svg aria-hidden="true" className="h-5 w-5" fill="none" viewBox="0 0 24 24">
      <path
        d="M10 6H8.2C7.0799 6 6.51984 6 6.09202 6.21799C5.71569 6.40973 5.40973 6.71569 5.21799 7.09202C5 7.51984 5 8.07989 5 9.2V15.8C5 16.9201 5 17.4802 5.21799 17.908C5.40973 18.2843 5.71569 18.5903 6.09202 18.782C6.51984 19 7.07989 19 8.2 19H14.8C15.9201 19 16.4802 19 16.908 18.782C17.2843 18.5903 17.5903 18.2843 17.782 17.908C18 17.4802 18 16.9201 18 15.8V14"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.8"
      />
      <path
        d="M13 5H19V11"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.8"
      />
      <path
        d="M19 5L11 13"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.8"
      />
    </svg>
  );
}

function ResetIcon() {
  return (
    <svg aria-hidden="true" className="h-4 w-4" fill="none" viewBox="0 0 24 24">
      <path
        d="M20 11C20 7.13 16.87 4 13 4C10.4 4 8.12 5.41 6.9 7.5"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1.8"
      />
      <path
        d="M7 3V8H2"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.8"
      />
      <path
        d="M4 13C4 16.87 7.13 20 11 20C13.6 20 15.88 18.59 17.1 16.5"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1.8"
      />
      <path
        d="M17 21V16H22"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.8"
      />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg aria-hidden="true" className="h-4 w-4" fill="none" viewBox="0 0 24 24">
      <path
        d="M6 6L18 18"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.8"
      />
      <path
        d="M18 6L6 18"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.8"
      />
    </svg>
  );
}
