import {
  LlmConnectionState,
  LlmGenerationResult,
  LlmModelInfo,
  LlmProviderConfig,
  LlmProviderError,
  LlmProviderId,
  LlmProviderPublicConfig,
  LlmPublicConfig,
  LlmRequest,
  LlmUsageSnapshot,
} from "./types";
import { SecureLlmConfigStore } from "./SecureLlmConfigStore";

type RuntimeState = {
  connectionState: LlmConnectionState;
  connectionMessage?: string;
  models: LlmModelInfo[];
  lastCheckedAt?: string;
};

const PROVIDERS: LlmProviderId[] = ["gemini", "openai", "anthropic", "openrouter", "groq", "custom"];
const DEFAULT_GEMINI_MODEL = "gemini-3.6-flash";

const DEFAULT_URLS: Record<LlmProviderId, string> = {
  gemini: "https://generativelanguage.googleapis.com/v1beta",
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com/v1",
  openrouter: "https://openrouter.ai/api/v1",
  groq: "https://api.groq.com/openai/v1",
  custom: "http://127.0.0.1:11434/v1",
};

export class LlmManager {
  private readonly store = new SecureLlmConfigStore();
  private readonly runtime = new Map<LlmProviderId, RuntimeState>();
  private lastUsage: LlmUsageSnapshot | null = null;

  public async initialize(): Promise<void> {
    await this.store.initialize();
    for (const provider of PROVIDERS) {
      this.runtime.set(provider, {
        connectionState: this.store.hasApiKey(provider) ? "not_configured" : "not_configured",
        models: [],
      });
    }
  }

  public hasConfiguredProvider(): boolean {
    return this.store.getConfiguredProviders().length > 0;
  }

  public async refreshConnections(): Promise<void> {
    const configured = PROVIDERS.filter((provider) => {
      const config = this.store.getProvider(provider);
      return Boolean(config?.enabled && (this.store.hasApiKey(provider) || provider === "custom"));
    });
    await Promise.allSettled(
      configured.map((provider) => this.saveAndTest({ provider, makePrimary: false })),
    );
  }

  public getLastUsage(): LlmUsageSnapshot | null {
    return this.lastUsage ? { ...this.lastUsage } : null;
  }

  public getPublicConfig(): LlmPublicConfig {
    const primaryProvider = this.store.getPrimaryProvider();
    return {
      primaryProvider,
      fallbackOrder: this.store.getFallbackOrder(),
      providers: PROVIDERS.map((provider) => this.getPublicProvider(provider)),
    };
  }

  public async migrateLegacyGemini(apiKey: string, model: string): Promise<void> {
    if (this.hasConfiguredProvider() || !apiKey.trim()) return;
    const migratedModel = /^gemini-2\.(?:0|5)-flash(?:$|-)/i.test(model)
      ? DEFAULT_GEMINI_MODEL
      : model;
    await this.store.saveProvider({
      provider: "gemini",
      enabled: true,
      model: migratedModel || DEFAULT_GEMINI_MODEL,
    }, apiKey, true);
  }

  public async saveAndTest(input: {
    provider: LlmProviderId;
    apiKey?: string;
    model?: string;
    baseUrl?: string;
    makePrimary?: boolean;
  }): Promise<LlmProviderPublicConfig> {
    const provider = input.provider;
    const runtime = this.getRuntime(provider);
    runtime.connectionState = "checking";
    runtime.connectionMessage = "Checking connection...";
    const existing = this.store.getProvider(provider);
    const apiKey = input.apiKey?.trim() || this.store.getApiKey(provider) || "";
    if (!apiKey && provider !== "custom") {
      runtime.connectionState = "invalid";
      runtime.connectionMessage = "API key is required.";
      throw new Error(runtime.connectionMessage);
    }
    const config: LlmProviderConfig = {
      provider,
      enabled: true,
      model: input.model?.trim() || existing?.model || "",
      baseUrl: input.baseUrl?.trim() || existing?.baseUrl,
    };
    try {
      const models = await this.listModels(provider, apiKey, config.baseUrl);
      if (!models.length) throw new Error("No compatible generation models were returned.");
      config.model = models.some((model) => model.id === config.model)
        ? config.model
        : this.pickDefaultModel(provider, models).id;
      await this.store.saveProvider(config, input.apiKey, input.makePrimary !== false);
      runtime.models = models;
      runtime.connectionState = "connected";
      runtime.connectionMessage = `${models.length} models available`;
      runtime.lastCheckedAt = new Date().toISOString();
      return this.getPublicProvider(provider);
    } catch (error: any) {
      const status = error instanceof LlmProviderError ? error.status : undefined;
      runtime.connectionState = status === 401 || status === 403 ? "invalid" : status === 429 ? "rate_limited" : "error";
      runtime.connectionMessage = error.message || "Connection failed.";
      runtime.lastCheckedAt = new Date().toISOString();
      throw error;
    }
  }

  public async setRouting(primaryProvider: LlmProviderId, fallbackOrder: LlmProviderId[]): Promise<LlmPublicConfig> {
    await this.store.setFallbackOrder(primaryProvider, fallbackOrder);
    return this.getPublicConfig();
  }

  public async generate(
    request: LlmRequest,
    onChunk: (accumulatedText: string) => void,
    signal: AbortSignal,
  ): Promise<LlmGenerationResult> {
    const primary = this.store.getPrimaryProvider();
    const order = Array.from(new Set([primary, ...this.store.getFallbackOrder()]));
    const candidates = order.filter((provider) => {
      const config = this.store.getProvider(provider);
      return Boolean(config?.enabled && (this.store.hasApiKey(provider) || provider === "custom"));
    });
    if (!candidates.length) throw new Error("No connected LLM provider. Configure one in Settings.");

    let accumulated = "";
    let lastError: Error | null = null;
    for (let attempt = 0; attempt < candidates.length; attempt += 1) {
      const provider = candidates[attempt];
      const config = this.store.getProvider(provider)!;
      const apiKey = this.store.getApiKey(provider) || "";
      const runtime = this.getRuntime(provider);
      try {
        const attemptRequest = accumulated
          ? {
              ...request,
              prompt: `${request.prompt}\n\nA previous provider stopped after producing this partial response. Continue without repeating it:\n${accumulated}`,
            }
          : request;
        const result = await this.generateWithProvider(
          config,
          apiKey,
          attemptRequest,
          (delta) => {
            accumulated += delta;
            onChunk(accumulated);
          },
          signal,
        );
        runtime.connectionState = "connected";
        runtime.connectionMessage = "Connected";
        this.lastUsage = { ...result.usage, fallbackAttempts: attempt };
        return { text: accumulated || result.text, usage: this.lastUsage };
      } catch (error: any) {
        if (signal.aborted || error?.name === "AbortError" || error?.message === "Request aborted") throw error;
        lastError = error instanceof Error ? error : new Error(String(error));
        const status = error instanceof LlmProviderError ? error.status : undefined;
        runtime.connectionState = status === 401 || status === 403 ? "invalid" : status === 429 ? "rate_limited" : "error";
        runtime.connectionMessage = lastError.message;
        const retryable = error instanceof LlmProviderError ? error.retryable || [401, 402, 403, 408, 429, 500, 502, 503, 504].includes(status || 0) : true;
        if (!retryable) break;
      }
    }
    throw lastError || new Error("All configured LLM providers failed.");
  }

  private getPublicProvider(provider: LlmProviderId): LlmProviderPublicConfig {
    const config = this.store.getProvider(provider);
    const runtime = this.getRuntime(provider);
    const key = this.store.getApiKey(provider);
    return {
      provider,
      enabled: config?.enabled ?? false,
      model: config?.model || "",
      baseUrl: config?.baseUrl || DEFAULT_URLS[provider],
      hasApiKey: Boolean(key),
      maskedApiKey: key ? `${key.slice(0, Math.min(4, key.length))}••••${key.slice(-4)}` : undefined,
      ...runtime,
    };
  }

  private getRuntime(provider: LlmProviderId): RuntimeState {
    let state = this.runtime.get(provider);
    if (!state) {
      state = { connectionState: "not_configured", models: [] };
      this.runtime.set(provider, state);
    }
    return state;
  }

  private async listModels(provider: LlmProviderId, apiKey: string, customBaseUrl?: string): Promise<LlmModelInfo[]> {
    const baseUrl = this.normalizeBaseUrl(customBaseUrl || DEFAULT_URLS[provider]);
    let url = `${baseUrl}/models`;
    const headers: Record<string, string> = {};
    if (provider === "gemini") url += `?key=${encodeURIComponent(apiKey)}`;
    else if (provider === "anthropic") {
      headers["x-api-key"] = apiKey;
      headers["anthropic-version"] = "2023-06-01";
    } else if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    const response = await fetch(url, { headers });
    if (!response.ok) throw await this.responseError(response);
    const payload: any = await response.json();
    if (provider === "gemini") {
      return (payload.models || [])
        .filter((model: any) => model.supportedGenerationMethods?.includes("generateContent"))
        .map((model: any) => ({
          id: String(model.name || "").replace(/^models\//, ""),
          name: model.displayName || model.name,
          contextWindow: model.inputTokenLimit,
          inputTokenLimit: model.inputTokenLimit,
          outputTokenLimit: model.outputTokenLimit,
          supportsVision: !/embedding|tts|image|audio/i.test(model.name || ""),
          supportsText: true,
        }));
    }
    const rows = payload.data || payload.models || [];
    return rows
      .map((model: any) => this.mapCompatibleModel(provider, model))
      .filter((model: LlmModelInfo) => model.id && model.supportsText);
  }

  private mapCompatibleModel(provider: LlmProviderId, model: any): LlmModelInfo {
    const id = String(model.id || model.name || "");
    const modalities: string[] = model.architecture?.input_modalities || [];
    const likelyTextModel = provider === "anthropic"
      ? /claude/i.test(id)
      : !/embedding|moderation|tts|audio|image|whisper|dall-e/i.test(id);
    const supportsVision = provider === "openrouter"
      ? modalities.includes("image")
      : /gpt-4o|gpt-4\.1|gpt-5|vision|claude-3|claude-(sonnet|opus|haiku)-[4-9]|llama.*vision/i.test(id);
    return {
      id,
      name: model.display_name || model.name || id,
      contextWindow: model.context_length || model.context_window || model.max_input_tokens,
      supportsVision,
      supportsText: likelyTextModel,
      pricing: model.pricing ? {
        prompt: Number(model.pricing.prompt || 0),
        completion: Number(model.pricing.completion || 0),
      } : undefined,
    };
  }

  private pickDefaultModel(provider: LlmProviderId, models: LlmModelInfo[]): LlmModelInfo {
    if (provider === "gemini") {
      const currentFlash = models.find((model) => model.id === DEFAULT_GEMINI_MODEL);
      if (currentFlash) return currentFlash;
    }
    const patterns: Record<LlmProviderId, RegExp> = {
      gemini: /flash/i,
      openai: /gpt-4\.1-mini|gpt-4o-mini|gpt-5-mini/i,
      anthropic: /sonnet/i,
      openrouter: /gemini.*flash|gpt.*mini|claude.*haiku/i,
      groq: /llama.*vision|llama-3/i,
      custom: /.*/,
    };
    return models.find((model) => patterns[provider].test(model.id)) || models[0];
  }

  private async generateWithProvider(
    config: LlmProviderConfig,
    apiKey: string,
    request: LlmRequest,
    onDelta: (delta: string) => void,
    signal: AbortSignal,
  ): Promise<LlmGenerationResult> {
    if (config.provider === "gemini") return this.generateGemini(config, apiKey, request, onDelta, signal);
    if (config.provider === "anthropic") return this.generateAnthropic(config, apiKey, request, onDelta, signal);
    return this.generateOpenAiCompatible(config, apiKey, request, onDelta, signal);
  }

  private async generateGemini(
    config: LlmProviderConfig,
    apiKey: string,
    request: LlmRequest,
    onDelta: (delta: string) => void,
    signal: AbortSignal,
  ): Promise<LlmGenerationResult> {
    const baseUrl = this.normalizeBaseUrl(config.baseUrl || DEFAULT_URLS.gemini);
    const url = `${baseUrl}/models/${encodeURIComponent(config.model)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(apiKey)}`;
    const parts: any[] = [{ text: request.prompt }];
    for (const image of request.images || []) {
      parts.push({ inline_data: { mime_type: image.mimeType, data: image.data } });
    }
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts }],
        generationConfig: {
          maxOutputTokens: request.maxOutputTokens || 4096,
          ...(config.model.startsWith("gemini-3")
            ? { thinkingConfig: { thinkingLevel: "low" } }
            : {}),
        },
      }),
      signal,
    });
    if (!response.ok) throw await this.responseError(response);
    let text = "";
    let usage: any = null;
    await this.readSse(response, (event) => {
      const chunk = event.candidates?.[0]?.content?.parts?.map((part: any) => part.text || "").join("") || "";
      if (chunk) { text += chunk; onDelta(chunk); }
      if (event.usageMetadata) usage = event.usageMetadata;
    });
    const inputTokens = usage?.promptTokenCount ?? this.estimateTokens(request.prompt, request.images?.length || 0);
    const outputTokens = usage?.candidatesTokenCount ?? this.estimateTokens(text);
    return { text, usage: this.buildUsage(config, inputTokens, outputTokens, !usage, response.headers) };
  }

  private async generateOpenAiCompatible(
    config: LlmProviderConfig,
    apiKey: string,
    request: LlmRequest,
    onDelta: (delta: string) => void,
    signal: AbortSignal,
  ): Promise<LlmGenerationResult> {
    const baseUrl = this.normalizeBaseUrl(config.baseUrl || DEFAULT_URLS[config.provider]);
    const content: any[] = [{ type: "text", text: request.prompt }];
    for (const image of request.images || []) {
      content.push({ type: "image_url", image_url: { url: `data:${image.mimeType};base64,${image.data}` } });
    }
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    if (config.provider === "openrouter") {
      headers["HTTP-Referer"] = "https://github.com/Aditya121raj/helper";
      headers["X-Title"] = "NoView";
    }
    const body: Record<string, unknown> = {
      model: config.model,
      messages: [{ role: "user", content }],
      stream: true,
      max_tokens: request.maxOutputTokens || 4096,
    };
    if (config.provider === "openrouter") body.usage = { include: true };
    else if (config.provider !== "custom") body.stream_options = { include_usage: true };
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal,
    });
    if (!response.ok) throw await this.responseError(response);
    let text = "";
    let usage: any = null;
    await this.readSse(response, (event) => {
      const delta = event.choices?.[0]?.delta?.content || "";
      if (delta) { text += delta; onDelta(delta); }
      if (event.usage) usage = event.usage;
    });
    const inputTokens = usage?.prompt_tokens ?? this.estimateTokens(request.prompt, request.images?.length || 0);
    const outputTokens = usage?.completion_tokens ?? this.estimateTokens(text);
    const snapshot = this.buildUsage(config, inputTokens, outputTokens, !usage, response.headers);
    if (usage?.cost != null) snapshot.cost = Number(usage.cost);
    return { text, usage: snapshot };
  }

  private async generateAnthropic(
    config: LlmProviderConfig,
    apiKey: string,
    request: LlmRequest,
    onDelta: (delta: string) => void,
    signal: AbortSignal,
  ): Promise<LlmGenerationResult> {
    const baseUrl = this.normalizeBaseUrl(config.baseUrl || DEFAULT_URLS.anthropic);
    const content: any[] = [{ type: "text", text: request.prompt }];
    for (const image of request.images || []) {
      content.push({ type: "image", source: { type: "base64", media_type: image.mimeType, data: image.data } });
    }
    const response = await fetch(`${baseUrl}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: config.model, messages: [{ role: "user", content }], max_tokens: request.maxOutputTokens || 4096, stream: true }),
      signal,
    });
    if (!response.ok) throw await this.responseError(response);
    let text = "";
    let inputTokens = this.estimateTokens(request.prompt, request.images?.length || 0);
    let outputTokens = 0;
    await this.readSse(response, (event) => {
      const delta = event.type === "content_block_delta" ? event.delta?.text || "" : "";
      if (delta) { text += delta; onDelta(delta); }
      if (event.type === "message_start") inputTokens = event.message?.usage?.input_tokens ?? inputTokens;
      if (event.type === "message_delta") outputTokens = event.usage?.output_tokens ?? outputTokens;
    });
    if (!outputTokens) outputTokens = this.estimateTokens(text);
    return { text, usage: this.buildUsage(config, inputTokens, outputTokens, false, response.headers) };
  }

  private buildUsage(
    config: LlmProviderConfig,
    inputTokens: number,
    outputTokens: number,
    estimated: boolean,
    headers: Headers,
  ): LlmUsageSnapshot {
    const runtimeModel = this.getRuntime(config.provider).models.find((model) => model.id === config.model);
    const contextLimit = runtimeModel?.contextWindow || runtimeModel?.inputTokenLimit;
    const totalTokens = inputTokens + outputTokens;
    return {
      provider: config.provider,
      model: config.model,
      inputTokens,
      outputTokens,
      totalTokens,
      contextLimit,
      contextRemaining: contextLimit ? Math.max(0, contextLimit - totalTokens) : undefined,
      estimated,
      rateLimitRemainingTokens: this.headerNumber(headers, "x-ratelimit-remaining-tokens"),
      rateLimitRemainingRequests: this.headerNumber(headers, "x-ratelimit-remaining-requests"),
      timestamp: new Date().toISOString(),
      fallbackAttempts: 0,
    };
  }

  private async readSse(response: Response, onEvent: (event: any) => void): Promise<void> {
    if (!response.body) throw new Error("Provider returned an empty stream.");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data || data === "[DONE]") continue;
        try { onEvent(JSON.parse(data)); } catch { /* Ignore keepalive/non-JSON lines. */ }
      }
    }
    if (buffer.startsWith("data:")) {
      const data = buffer.slice(5).trim();
      if (data && data !== "[DONE]") {
        try { onEvent(JSON.parse(data)); } catch { /* Ignore incomplete trailing data. */ }
      }
    }
  }

  private async responseError(response: Response): Promise<LlmProviderError> {
    let message = `${response.status} ${response.statusText}`;
    let code: string | undefined;
    try {
      const body: any = await response.json();
      message = body.error?.message || body.message || body.error || message;
      code = body.error?.type || body.error?.code || body.code;
    } catch { /* Keep status text. */ }
    return new LlmProviderError(message, response.status, code, [408, 429, 500, 502, 503, 504].includes(response.status));
  }

  private estimateTokens(text: string, imageCount = 0): number {
    return Math.max(1, Math.ceil(text.length / 4) + imageCount * 1000);
  }

  private normalizeBaseUrl(url: string): string {
    return url.replace(/\/+$/, "");
  }

  private headerNumber(headers: Headers, name: string): number | undefined {
    const value = Number(headers.get(name));
    return Number.isFinite(value) ? value : undefined;
  }
}
