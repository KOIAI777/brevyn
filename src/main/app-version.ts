import { app } from "electron";

export function getBrevynAppVersion(): string {
  return app.getVersion();
}

export function getBrevynClientAppName(): string {
  return `brevyn/${getBrevynAppVersion()}`;
}
