import type { PluginRuntime } from "openclaw/plugin-sdk";

let runtime: PluginRuntime | null = null;

export function setAppleMailRuntime(next: PluginRuntime) {
  runtime = next;
}

export function getAppleMailRuntime(): PluginRuntime {
  if (!runtime) {
    throw new Error("Apple Mail runtime not initialized");
  }
  return runtime;
}
