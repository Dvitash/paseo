import type { ComponentProps } from "react";
import { FilePane } from "@/file-pane/pane";

export type FilePaneLoaderProps = ComponentProps<typeof FilePane>;

export function FilePaneLoader(props: FilePaneLoaderProps) {
  return <FilePane {...props} />;
}
