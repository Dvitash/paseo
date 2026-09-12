import type { PluginClientContext } from "@getpaseo/plugin/client";
import { Platform } from "react-native";
import { startDesktopAutomation } from "./client/automation";
import { DesktopPanel } from "./client/panel";
import { desktopEventsRpc } from "./shared/rpc";

export default function contribute(client: PluginClientContext) {
  const removePanel = client.addWorkspacePanel({
    id: "desktop",
    title: "Desktop",
    icon: "Monitor",
    context: "workspace",
    Component: DesktopPanel,
  });

  const removeCommand = client.addCommandCenterItem({
    id: "open-desktop",
    title: "Open desktop",
    icon: "Monitor",
    context: "workspace",
    onSelect(context) {
      context.openPanel("desktop");
    },
  });

  let stopAutomation: (() => void) | undefined;
  if (Platform.OS === "web") {
    const automation = startDesktopAutomation({
      fetchEvents(input) {
        return client.rpc(desktopEventsRpc, input);
      },
      openPanel(workspaceId) {
        client.openPanel("desktop", { workspaceId });
      },
    });
    stopAutomation = () => {
      automation.stop();
    };
  }

  return () => {
    stopAutomation?.();
    removeCommand();
    removePanel();
  };
}
