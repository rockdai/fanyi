import type { Settings } from "./settings";

export const TRANSLATE_PORT = "fanyi-translate";

export interface TranslateTextsMessage {
  type: "TRANSLATE_TEXTS";
  texts: string[];
  sourceLanguage: string;
  targetLanguage: string;
}

export interface TestProviderMessage {
  type: "TEST_PROVIDER";
}

export interface ContentCommandMessage {
  type: "GET_PAGE_STATE" | "TOGGLE_PAGE" | "RESTART_TRANSLATION" | "SETTINGS_UPDATED" | "TRANSLATE_CURRENT_SELECTION";
}

export interface ShowSelectionMessage {
  type: "SHOW_SELECTION_TRANSLATION";
  text: string;
}

export interface PageStateChangedMessage {
  type: "PAGE_STATE_CHANGED";
  active: boolean;
}

export type RuntimeMessage = TranslateTextsMessage | TestProviderMessage | ContentCommandMessage | ShowSelectionMessage | PageStateChangedMessage;

export interface TranslationResponse {
  ok: boolean;
  translations?: string[];
  error?: string;
}

export interface PageStateResponse {
  active: boolean;
  translating: boolean;
  supported: boolean;
  translatedCount: number;
}

export interface SettingsChangedPayload {
  settings: Settings;
}
