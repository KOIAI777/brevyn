export interface SseEvent {
  event?: string;
  data: string;
}

export function parseSseEvents(input: string): SseEvent[] {
  const normalized = input.replace(/\r\n/g, "\n");
  return normalized
    .split(/\n\n+/)
    .flatMap((block) => {
      const event = parseSseBlock(block);
      return event ? [event] : [];
    });
}

export function parseSseBlock(block: string): SseEvent | null {
  const lines = block.split(/\n/);
  let event: string | undefined;
  const data: string[] = [];

  for (const line of lines) {
    if (!line || line.startsWith(":")) continue;
    const separatorIndex = line.indexOf(":");
    const field = separatorIndex >= 0 ? line.slice(0, separatorIndex) : line;
    const rawValue = separatorIndex >= 0 ? line.slice(separatorIndex + 1) : "";
    const value = rawValue.startsWith(" ") ? rawValue.slice(1) : rawValue;

    if (field === "event") event = value;
    if (field === "data") data.push(value);
  }

  if (data.length === 0) return null;
  return { event, data: data.join("\n") };
}

export function formatSseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

