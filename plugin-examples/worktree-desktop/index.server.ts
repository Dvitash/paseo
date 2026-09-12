import type { PluginCleanup } from "@getpaseo/plugin";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { registerDesktopPlugin } from "./server/plugin";

export default function contribute(server: PluginServerContext): PluginCleanup {
  return registerDesktopPlugin(server);
}
