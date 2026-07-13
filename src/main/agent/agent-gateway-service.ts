import type { AgentGatewayStatus } from "../../types/domain";
import { LocalAnthropicGateway, type LocalAnthropicGatewayRegistration, type LocalAnthropicGatewaySession } from "./local-anthropic-gateway";

interface AgentGatewayServiceOptions {
  gateway?: LocalAnthropicGateway;
  enabled?: boolean;
}

export class AgentGatewayService {
  private readonly gateway: LocalAnthropicGateway;
  private enabled: boolean;
  private activeTokens = new Set<string>();
  private state: AgentGatewayStatus["state"] = "disabled";
  private url = "";
  private error = "";
  private startPromise?: Promise<string>;

  constructor(options: AgentGatewayServiceOptions = {}) {
    this.gateway = options.gateway || new LocalAnthropicGateway();
    this.enabled = Boolean(options.enabled);
  }

  getStatus(): AgentGatewayStatus {
    return {
      enabled: this.enabled,
      state: this.state,
      url: this.url || undefined,
      activeRuns: this.activeTokens.size,
      error: this.error || undefined,
    };
  }

  async syncConfiguredState(): Promise<AgentGatewayStatus> {
    if (this.enabled) {
      await this.start();
    } else if (this.activeTokens.size === 0) {
      await this.stop();
    }
    return this.getStatus();
  }

  async setEnabled(enabled: boolean): Promise<AgentGatewayStatus> {
    this.enabled = enabled;
    this.error = "";
    if (enabled) {
      await this.start();
    } else if (this.activeTokens.size === 0) {
      await this.stop();
    }
    return this.getStatus();
  }

  async start(): Promise<string> {
    if (this.state === "running" && this.url) return this.url;
    if (this.startPromise) return this.startPromise;
    this.state = "starting";
    this.error = "";
    this.startPromise = this.gateway.start()
      .then((url) => {
        this.url = url;
        this.state = "running";
        return url;
      })
      .catch((error) => {
        this.url = "";
        this.state = "failed";
        this.error = error instanceof Error ? error.message : String(error);
        throw error;
      })
      .finally(() => {
        this.startPromise = undefined;
      });
    return this.startPromise;
  }

  registerSession(session: LocalAnthropicGatewaySession): LocalAnthropicGatewayRegistration {
    const registration = this.gateway.registerSession(session);
    this.activeTokens.add(registration.token);
    this.state = "running";
    if (!this.url) this.url = registration.baseUrl;
    return registration;
  }

  unregisterSession(token: string): void {
    const deleted = this.activeTokens.delete(token);
    this.gateway.unregisterSession(token);
    if (deleted && !this.enabled && this.activeTokens.size === 0) {
      void this.stop();
    }
  }

  async stop(): Promise<void> {
    if (this.activeTokens.size > 0) return;
    if (this.state === "disabled" && !this.url) return;
    this.state = "stopping";
    await this.gateway.stop();
    this.url = "";
    this.error = "";
    this.state = "disabled";
  }

  async close(): Promise<void> {
    this.enabled = false;
    this.activeTokens.clear();
    await this.gateway.stop();
    this.url = "";
    this.state = "disabled";
    this.error = "";
  }
}
