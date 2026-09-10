import type { PluginCleanup } from "@getpaseo/plugin";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { DesktopManager, type DesktopManagerOptions } from "./manager";
import { desktopEventsRpc, desktopStatusRpc } from "../shared/rpc";

export function registerDesktopPlugin(
  server: PluginServerContext,
  options?: DesktopManagerOptions,
): PluginCleanup {
  const manager = new DesktopManager(options);

  server.handle(desktopStatusRpc, async (input, context) => {
    const workspace = await context.paseo.workspaces.ref(input.workspaceId).refresh();
    return manager.getStatus(input.workspaceId, workspace?.workspaceDirectory ?? null);
  });

  server.handle(desktopEventsRpc, async (input) => {
    return manager.pollEvents(input.cursor);
  });

  server.on("workspace.created", (event) => {
    manager.onWorkspaceCreated(event);
  });

  server.on("workspace.archived", (event) => {
    manager.onWorkspaceArchived(event);
  });

  server.before("agent.session_open", ({ request }) => {
    return manager.onAgentSessionOpen(request);
  });

  return () => {
    manager.dispose();
  };
}
