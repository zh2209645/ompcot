import { t } from "./i18n.js";

export function getOnboardingState({ hasSessions, workspacePath, availableModels }) {
  const hasWorkspace = typeof workspacePath === "string" && workspacePath.trim().length > 0;
  const hasModel = Array.isArray(availableModels) && availableModels.length > 0;

  if (!hasWorkspace && !hasSessions) {
    return {
      canQuery: false,
      canType: false,
      needsProject: true,
      needsModel: false,
      message: t("session.onboardingNeedsProject"),
    };
  }

  if (!hasModel) {
    return {
      canQuery: false,
      canType: true,
      needsProject: false,
      needsModel: true,
      message: t("session.onboardingNeedsModel"),
    };
  }

  return {
    canQuery: true,
    canType: true,
    needsProject: false,
    needsModel: false,
    message: "",
  };
}
