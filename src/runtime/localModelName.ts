export function normalizeLocalModelName(value: string): string {
  const normalizedValue = value.trim().toLowerCase();

  if (normalizedValue.endsWith(':latest')) {
    return normalizedValue.slice(0, -':latest'.length);
  }

  return normalizedValue;
}

export function areLocalModelNamesEquivalent(
  left: string,
  right: string,
): boolean {
  const normalizedLeft = normalizeLocalModelName(left);
  const normalizedRight = normalizeLocalModelName(right);

  return normalizedLeft.length > 0 && normalizedLeft === normalizedRight;
}

export function filterVisibleLocalModels(
  models: string[],
  hiddenModel: string,
): string[] {
  const normalizedHiddenModel = normalizeLocalModelName(hiddenModel);
  if (normalizedHiddenModel.length === 0) return models;

  return models.filter(
    (model) => normalizeLocalModelName(model) !== normalizedHiddenModel,
  );
}

export function hasLocalModelSelectionChanged(
  pendingSelection: string,
  configuredSelection: string,
): boolean {
  const normalizedPendingSelection = normalizeLocalModelName(pendingSelection);
  if (normalizedPendingSelection.length === 0) return false;

  return (
    normalizedPendingSelection !==
    normalizeLocalModelName(configuredSelection)
  );
}
