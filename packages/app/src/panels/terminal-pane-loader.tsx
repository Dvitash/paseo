import type { ComponentProps } from "react";
import { TerminalPane } from "@/components/terminal-pane";

export type TerminalPaneLoaderProps = ComponentProps<typeof TerminalPane>;

export function TerminalPaneLoader(props: TerminalPaneLoaderProps) {
  return <TerminalPane {...props} />;
}
