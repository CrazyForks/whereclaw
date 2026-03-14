export type ModelStepUiStateInput = {
  wantsLocalModel: boolean | null;
  localModelName: string;
  isValidatingLocalModelName: boolean;
};

export type ModelStepUiState = {
  disableContinue: boolean;
  showNoLocalModelHint: boolean;
};

export function getModelStepUiState(
  input: ModelStepUiStateInput,
): ModelStepUiState {
  return {
    disableContinue:
      input.wantsLocalModel === null ||
      input.isValidatingLocalModelName ||
      (input.wantsLocalModel === true && input.localModelName.trim().length === 0),
    showNoLocalModelHint: input.wantsLocalModel === false,
  };
}
