/// <reference types="vite/client" />

import type { BrevynAPI } from "@/types/domain";

declare global {
  const __APP_VERSION__: string;

  interface Window {
    __BREVYN_STARTUP_SPLASH_SHOWN_AT__?: number;
    brevyn: BrevynAPI;
  }
}
