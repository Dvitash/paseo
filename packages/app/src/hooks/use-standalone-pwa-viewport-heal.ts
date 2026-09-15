import { useEffect } from "react";
import { isWeb } from "@/constants/platform";
import { installStandalonePwaViewport } from "./standalone-pwa-viewport";

export function useStandalonePwaViewportHeal() {
  useEffect(() => {
    if (!isWeb) return;
    return installStandalonePwaViewport(window);
  }, []);
}
