export type QqContinueButtonStateInput = {
  wantsQqChannel: boolean | null;
  qqAppId: string;
  qqAppSecret: string;
  isApplyingInitialSetup: boolean;
};

export type QqContinueButtonState = {
  disabled: boolean;
  showLoading: boolean;
};

export function getQqContinueButtonState(
  input: QqContinueButtonStateInput,
): QqContinueButtonState {
  const requiresQqCredentials = input.wantsQqChannel === true;
  const missingQqCredentials =
    requiresQqCredentials &&
    (input.qqAppId.trim().length === 0 || input.qqAppSecret.trim().length === 0);

  return {
    disabled:
      input.isApplyingInitialSetup ||
      input.wantsQqChannel === null ||
      missingQqCredentials,
    showLoading: input.isApplyingInitialSetup,
  };
}
