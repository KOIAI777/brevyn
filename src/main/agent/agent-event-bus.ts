import { EventEmitter } from "node:events";
import type { BrevynAgentEvent } from "../../types/domain";

export type AgentEventListener = (event: BrevynAgentEvent) => void;

export class AgentEventBus {
  private readonly emitter = new EventEmitter();

  emit(event: BrevynAgentEvent): void {
    this.emitter.emit("event", event);
  }

  on(listener: AgentEventListener): () => void {
    this.emitter.on("event", listener);
    return () => this.emitter.off("event", listener);
  }
}
