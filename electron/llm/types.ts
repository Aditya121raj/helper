export type LlmProviderId = "gemini" | "openai" | "anthropic" | "openrouter" | "groq" | "custom";

export type LlmConnectionState = "not_configured" | "checking" | "connected" | "invalid" | "rate_limited" | "error";

export interface LlmModelInfo {
  id: string;
  name: string;
  contextWindow?: number;
  inputTokenLimit?: number;
  outputTokenLimit?: number;
  supportsVision: boolean;
  supportsText: boolean;
  pricing?: { prompt?: number; completion?: number };
}

export interface LlmProviderConfig {
  provider: LlmProviderId;
  enabled: boolean;
  model: string;
  baseUrl?: string;
}

export interface LlmProviderPublicConfig extends LlmProviderConfig {
  hasApiKey: boolean;
  maskedApiKey?: string;
  connectionState: LlmConnectionState;
  connectionMessage?: string;
  models: LlmModelInfo[];
  lastCheckedAt?: string;
}

export interface LlmPublicConfig {
  primaryProvider: LlmProviderId;
  fallbackOrder: LlmProviderId[];
  providers: LlmProviderPublicConfig[];
}

export interface LlmImageInput {
  data: string;
  mimeType: string;
}

export interface LlmRequest {
  prompt: string;
  images?: LlmImageInput[];
  maxOutputTokens?: number;
}

export interface LlmUsageSnapshot {
  provider: LlmProviderId;
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  contextLimit?: number;
  contextRemaining?: number;
  estimated: boolean;
  cost?: number;
  rateLimitRemainingTokens?: number;
  rateLimitRemainingRequests?: number;
  timestamp: string;
  fallbackAttempts: number;
}

export interface LlmGenerationResult {
  text: string;
  usage: LlmUsageSnapshot;
}

export class LlmProviderError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly code?: string,
    public readonly retryable = false,
  ) {
    super(message);
    this.name = "LlmProviderError";
  }
}
