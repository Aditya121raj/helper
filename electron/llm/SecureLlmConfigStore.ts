import { app, safeStorage } from "electron";
import fs from "node:fs/promises";
import path from "node:path";
import { LlmProviderConfig, LlmProviderId } from "./types";

interface StoredProvider extends LlmProviderConfig {
  encryptedApiKey?: string;
}

interface StoredConfig {
  version: 1;
  primaryProvider: LlmProviderId;
  fallbackOrder: LlmProviderId[];
  providers: Partial<Record<LlmProviderId, StoredProvider>>;
}

const DEFAULT_ORDER: LlmProviderId[] = ["gemini", "openai", "anthropic", "openrouter", "groq", "custom"];
const DEFAULT_GEMINI_MODEL = "gemini-3.6-flash";

export class SecureLlmConfigStore {
  private readonly configPath = path.join(app.getPath("userData"), "llm-providers.json");
  private config: StoredConfig = {
    version: 1,
    primaryProvider: "gemini",
    fallbackOrder: DEFAULT_ORDER,
    providers: {},
  };

  public async initialize(): Promise<void> {
    try {
      const raw = await fs.readFile(this.configPath, "utf8");
      const parsed = JSON.parse(raw) as StoredConfig;
      this.config = {
        version: 1,
        primaryProvider: parsed.primaryProvider || "gemini",
        fallbackOrder: this.normalizeOrder(parsed.fallbackOrder || DEFAULT_ORDER),
        providers: parsed.providers || {},
      };
      await this.removeUndecryptableApiKeys();
      await this.migrateDeprecatedGeminiModel();
    } catch (error: any) {
      if (error?.code !== "ENOENT") console.warn("Unable to load LLM provider config:", error);
      await this.persist();
    }
  }

  private canDecryptApiKey(encryptedApiKey: string): boolean {
    try {
      if (!safeStorage.isEncryptionAvailable()) return false;
      safeStorage.decryptString(Buffer.from(encryptedApiKey, "base64"));
      return true;
    } catch {
      return false;
    }
  }

  private async removeUndecryptableApiKeys(): Promise<void> {
    let changed = false;
    for (const provider of Object.values(this.config.providers)) {
      if (provider?.encryptedApiKey && !this.canDecryptApiKey(provider.encryptedApiKey)) {
        delete provider.encryptedApiKey;
        changed = true;
      }
    }
    if (changed) {
      console.warn("Removed an API key that Windows could no longer decrypt; it must be entered again.");
      await this.persist();
    }
  }

  private async migrateDeprecatedGeminiModel(): Promise<void> {
    const gemini = this.config.providers.gemini;
    if (!gemini || !/^gemini-2\.(?:0|5)-flash(?:$|-)/i.test(gemini.model || "")) return;
    gemini.model = DEFAULT_GEMINI_MODEL;
    await this.persist();
    console.log(`Migrated deprecated Gemini model to ${DEFAULT_GEMINI_MODEL}.`);
  }

  public getPrimaryProvider(): LlmProviderId {
    return this.config.primaryProvider;
  }

  public getFallbackOrder(): LlmProviderId[] {
    return [...this.config.fallbackOrder];
  }

  public getProvider(provider: LlmProviderId): LlmProviderConfig | null {
    const stored = this.config.providers[provider];
    if (!stored) return null;
    const { encryptedApiKey: _secret, ...publicConfig } = stored;
    return publicConfig;
  }

  public getApiKey(provider: LlmProviderId): string | null {
    const encrypted = this.config.providers[provider]?.encryptedApiKey;
    if (!encrypted) return null;
    try {
      if (!safeStorage.isEncryptionAvailable()) return null;
      return safeStorage.decryptString(Buffer.from(encrypted, "base64"));
    } catch (error) {
      console.error(`Unable to decrypt ${provider} API key:`, error);
      return null;
    }
  }

  public hasApiKey(provider: LlmProviderId): boolean {
    return Boolean(this.config.providers[provider]?.encryptedApiKey);
  }

  public getConfiguredProviders(): LlmProviderId[] {
    return DEFAULT_ORDER.filter((provider) => this.hasApiKey(provider));
  }

  public async saveProvider(
    config: LlmProviderConfig,
    apiKey?: string,
    makePrimary = false,
  ): Promise<void> {
    const previous = this.config.providers[config.provider];
    let encryptedApiKey = previous?.encryptedApiKey;
    if (apiKey?.trim()) {
      if (!safeStorage.isEncryptionAvailable()) {
        throw new Error("OS encryption is unavailable; API key was not saved.");
      }
      encryptedApiKey = safeStorage.encryptString(apiKey.trim()).toString("base64");
    }
    this.config.providers[config.provider] = { ...config, encryptedApiKey };
    if (makePrimary) this.config.primaryProvider = config.provider;
    this.config.fallbackOrder = this.normalizeOrder([
      this.config.primaryProvider,
      ...this.config.fallbackOrder,
      config.provider,
    ]);
    await this.persist();
  }

  public async setFallbackOrder(primary: LlmProviderId, order: LlmProviderId[]): Promise<void> {
    this.config.primaryProvider = primary;
    this.config.fallbackOrder = this.normalizeOrder([primary, ...order]);
    await this.persist();
  }

  private normalizeOrder(order: LlmProviderId[]): LlmProviderId[] {
    return Array.from(new Set([...order, ...DEFAULT_ORDER])).filter((provider): provider is LlmProviderId =>
      DEFAULT_ORDER.includes(provider),
    );
  }

  private async persist(): Promise<void> {
    await fs.mkdir(path.dirname(this.configPath), { recursive: true });
    const tempPath = `${this.configPath}.tmp`;
    await fs.writeFile(tempPath, JSON.stringify(this.config, null, 2), "utf8");
    try {
      await fs.rename(tempPath, this.configPath);
    } catch {
      await fs.copyFile(tempPath, this.configPath);
      await fs.rm(tempPath, { force: true });
    }
  }
}
