import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { appleMailPlugin } from "./src/channel.js";
import { setAppleMailRuntime } from "./src/runtime.js";

const plugin = {
  ...appleMailPlugin,
  register: (api: OpenClawPluginApi) => {
    setAppleMailRuntime(api.runtime);
    api.registerChannel(appleMailPlugin);
  }
};

export default plugin;
