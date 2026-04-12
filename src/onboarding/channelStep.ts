export type InitialChannelSelection = "weixin" | "qq" | "none";

export type ChannelContinueButtonStateInput = {
  selectedChannel: InitialChannelSelection | null;
  qqAppId: string;
  qqAppSecret: string;
  isApplyingInitialSetup: boolean;
  isStartingWeixinLogin: boolean;
  isWaitingForWeixinLogin: boolean;
};

export type ChannelContinueButtonState = {
  disabled: boolean;
  showLoading: boolean;
};

export function getChannelContinueButtonState(
  input: ChannelContinueButtonStateInput,
): ChannelContinueButtonState {
  const requiresQqCredentials = input.selectedChannel === "qq";
  const missingQqCredentials =
    requiresQqCredentials &&
    (input.qqAppId.trim().length === 0 || input.qqAppSecret.trim().length === 0);
  const showLoading =
    input.isApplyingInitialSetup ||
    input.isStartingWeixinLogin ||
    input.isWaitingForWeixinLogin;

  return {
    disabled:
      showLoading || input.selectedChannel === null || missingQqCredentials,
    showLoading,
  };
}
