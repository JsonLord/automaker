import { create } from 'zustand';
import type { GeminiAuthStatus } from '@automaker/types';

export interface CliStatus {
  installed: boolean;
  path: string | null;
  version: string | null;
  method: string;
  hasApiKey?: boolean;
  error?: string;
}

export interface GhCliStatus {
  installed: boolean;
  authenticated: boolean;
  version: string | null;
  path: string | null;
  user: string | null;
  error?: string;
}

export interface CursorCliStatus {
  installed: boolean;
  version?: string | null;
  path?: string | null;
  auth?: {
    authenticated: boolean;
    method: string;
  };
  installCommand?: string;
  loginCommand?: string;
  error?: string;
}

export interface CodexCliStatus {
  installed: boolean;
  version?: string | null;
  path?: string | null;
  auth?: {
    authenticated: boolean;
    method: string;
  };
  installCommand?: string;
  loginCommand?: string;
  error?: string;
}

export interface OpencodeCliStatus {
  installed: boolean;
  version?: string | null;
  path?: string | null;
  auth?: {
    authenticated: boolean;
    method: string;
  };
  installCommand?: string;
  loginCommand?: string;
  error?: string;
}

export interface GeminiCliStatus {
  installed: boolean;
  version?: string | null;
  path?: string | null;
  auth?: {
    authenticated: boolean;
    method: string;
    hasApiKey?: boolean;
    hasEnvApiKey?: boolean;
  };
  installCommand?: string;
  loginCommand?: string;
  error?: string;
}

export interface CopilotCliStatus {
  installed: boolean;
  version?: string | null;
  path?: string | null;
  auth?: {
    authenticated: boolean;
    method: string;
    login?: string;
    host?: string;
  };
  installCommand?: string;
  loginCommand?: string;
  error?: string;
}

export interface JulesCliStatus {
  installed: boolean;
  version?: string | null;
  path?: string | null;
  auth?: {
    authenticated: boolean;
    method: string;
  };
  error?: string;
}

export type CodexAuthMethod =
  | 'api_key_env'
  | 'api_key'
  | 'cli_authenticated'
  | 'none';

export interface CodexAuthStatus {
  authenticated: boolean;
  method: CodexAuthMethod;
  hasAuthFile?: boolean;
  hasApiKey?: boolean;
  hasEnvApiKey?: boolean;
  error?: string;
}

export type ZaiAuthMethod =
  | 'api_key_env'
  | 'api_key'
  | 'none';

export interface ZaiAuthStatus {
  authenticated: boolean;
  method: ZaiAuthMethod;
  hasApiKey?: boolean;
  hasEnvApiKey?: boolean;
  error?: string;
}

export type { GeminiAuthStatus };

export type ClaudeAuthMethod =
  | 'oauth_token_env'
  | 'oauth_token'
  | 'api_key_env'
  | 'api_key'
  | 'credentials_file'
  | 'cli_authenticated'
  | 'none';

export interface ClaudeAuthStatus {
  authenticated: boolean;
  method: ClaudeAuthMethod;
  hasCredentialsFile?: boolean;
  oauthTokenValid?: boolean;
  apiKeyValid?: boolean;
  hasEnvOAuthToken?: boolean;
  hasEnvApiKey?: boolean;
  error?: string;
}

export interface InstallProgress {
  isInstalling: boolean;
  currentStep: string;
  progress: number;
  output: string[];
  error?: string;
}

export type SetupStep =
  | 'welcome'
  | 'theme'
  | 'providers'
  | 'claude_detect'
  | 'claude_auth'
  | 'cursor'
  | 'codex'
  | 'opencode'
  | 'gemini'
  | 'copilot'
  | 'github'
  | 'complete';

export interface SetupState {
  isFirstRun: boolean;
  setupComplete: boolean;
  currentStep: SetupStep;
  claudeCliStatus: CliStatus | null;
  claudeAuthStatus: ClaudeAuthStatus | null;
  claudeInstallProgress: InstallProgress;
  claudeIsVerifying: boolean;
  ghCliStatus: GhCliStatus | null;
  cursorCliStatus: CursorCliStatus | null;
  codexCliStatus: CliStatus | null;
  codexAuthStatus: CodexAuthStatus | null;
  codexInstallProgress: InstallProgress;
  opencodeCliStatus: OpencodeCliStatus | null;
  geminiCliStatus: GeminiCliStatus | null;
  geminiAuthStatus: GeminiAuthStatus | null;
  copilotCliStatus: CopilotCliStatus | null;
  julesCliStatus: JulesCliStatus | null;
  zaiAuthStatus: ZaiAuthStatus | null;
  skipClaudeSetup: boolean;
}

export interface SetupActions {
  setCurrentStep: (step: SetupStep) => void;
  setSetupComplete: (complete: boolean) => void;
  completeSetup: () => void;
  resetSetup: () => void;
  setIsFirstRun: (isFirstRun: boolean) => void;
  setClaudeCliStatus: (status: CliStatus | null) => void;
  setClaudeAuthStatus: (status: ClaudeAuthStatus | null) => void;
  setClaudeInstallProgress: (progress: Partial<InstallProgress>) => void;
  resetClaudeInstallProgress: () => void;
  setClaudeIsVerifying: (isVerifying: boolean) => void;
  setGhCliStatus: (status: GhCliStatus | null) => void;
  setCursorCliStatus: (status: CursorCliStatus | null) => void;
  setCodexCliStatus: (status: CliStatus | null) => void;
  setCodexAuthStatus: (status: CodexAuthStatus | null) => void;
  setCodexInstallProgress: (progress: Partial<InstallProgress>) => void;
  resetCodexInstallProgress: () => void;
  setOpencodeCliStatus: (status: OpencodeCliStatus | null) => void;
  setGeminiCliStatus: (status: GeminiCliStatus | null) => void;
  setGeminiAuthStatus: (status: GeminiAuthStatus | null) => void;
  setCopilotCliStatus: (status: CopilotCliStatus | null) => void;
  setJulesCliStatus: (status: JulesCliStatus | null) => void;
  setZaiAuthStatus: (status: ZaiAuthStatus | null) => void;
  setSkipClaudeSetup: (skip: boolean) => void;
}

const initialInstallProgress: InstallProgress = {
  isInstalling: false,
  currentStep: '',
  progress: 0,
  output: [],
};

const shouldSkipSetup = import.meta.env.VITE_SKIP_SETUP === 'true';

function getInitialSetupComplete(): boolean {
  if (shouldSkipSetup) return true;
  try {
    const raw = localStorage.getItem('automaker-settings-cache');
    if (raw) {
      const parsed = JSON.parse(raw) as { setupComplete?: boolean };
      if (parsed?.setupComplete === true) return true;
    }
  } catch {
  }
  return false;
}

const initialSetupComplete = getInitialSetupComplete();

const initialState: SetupState = {
  isFirstRun: !shouldSkipSetup && !initialSetupComplete,
  setupComplete: initialSetupComplete,
  currentStep: initialSetupComplete ? 'complete' : 'welcome',
  claudeCliStatus: null,
  claudeAuthStatus: null,
  claudeInstallProgress: { ...initialInstallProgress },
  claudeIsVerifying: false,
  ghCliStatus: null,
  cursorCliStatus: null,
  codexCliStatus: null,
  codexAuthStatus: null,
  codexInstallProgress: { ...initialInstallProgress },
  opencodeCliStatus: null,
  geminiCliStatus: null,
  geminiAuthStatus: null,
  copilotCliStatus: null,
  julesCliStatus: null,
  zaiAuthStatus: null,
  skipClaudeSetup: shouldSkipSetup,
};

export const useSetupStore = create<SetupState & SetupActions>()((set, get) => ({
  ...initialState,
  setCurrentStep: (step) => set({ currentStep: step }),
  setSetupComplete: (complete) =>
    set({
      setupComplete: complete,
      currentStep: complete ? 'complete' : 'welcome',
    }),
  completeSetup: () => set({ setupComplete: true, currentStep: 'complete' }),
  resetSetup: () =>
    set({
      ...initialState,
      setupComplete: false,
      currentStep: 'welcome',
      isFirstRun: false,
    }),
  setIsFirstRun: (isFirstRun) => set({ isFirstRun }),
  setClaudeCliStatus: (status) => set({ claudeCliStatus: status }),
  setClaudeAuthStatus: (status) => set({ claudeAuthStatus: status }),
  setClaudeInstallProgress: (progress) =>
    set({
      claudeInstallProgress: {
        ...get().claudeInstallProgress,
        ...progress,
      },
    }),
  resetClaudeInstallProgress: () =>
    set({
      claudeInstallProgress: { ...initialInstallProgress },
    }),
  setClaudeIsVerifying: (isVerifying) => set({ claudeIsVerifying: isVerifying }),
  setGhCliStatus: (status) => set({ ghCliStatus: status }),
  setCursorCliStatus: (status) => set({ cursorCliStatus: status }),
  setCodexCliStatus: (status) => set({ codexCliStatus: status }),
  setCodexAuthStatus: (status) => set({ codexAuthStatus: status }),
  setCodexInstallProgress: (progress) =>
    set({
      codexInstallProgress: {
        ...get().codexInstallProgress,
        ...progress,
      },
    }),
  resetCodexInstallProgress: () =>
    set({
      codexInstallProgress: { ...initialInstallProgress },
    }),
  setOpencodeCliStatus: (status) => set({ opencodeCliStatus: status }),
  setGeminiCliStatus: (status) => set({ geminiCliStatus: status }),
  setGeminiAuthStatus: (status) => set({ geminiAuthStatus: status }),
  setCopilotCliStatus: (status) => set({ copilotCliStatus: status }),
  setJulesCliStatus: (status) => set({ julesCliStatus: status }),
  setZaiAuthStatus: (status) => set({ zaiAuthStatus: status }),
  setSkipClaudeSetup: (skip) => set({ skipClaudeSetup: skip }),
}));
