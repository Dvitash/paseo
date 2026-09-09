import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { SettingsSection } from "@/components/settings/headings/settings-section";
import { Button } from "@/components/ui/button";
import { getIsElectron } from "@/constants/platform";
import type { WebPushHostStatus } from "@/push-notifications/internal/web-push-types";
import { useHostWebPush } from "@/push-notifications/use-host-web-push";
import { settingsStyles } from "@/styles/settings";

export interface HostWebPushSectionProps {
  serverId: string;
}

export function HostWebPushSection({ serverId }: HostWebPushSectionProps) {
  const { t } = useTranslation();

  if (getIsElectron()) {
    return null;
  }

  return <HostWebPushSectionContent serverId={serverId} t={t} />;
}

function getHintText(status: WebPushHostStatus, t: TFunction): string {
  switch (status.kind) {
    case "unsupported-insecure":
      return t("settings.host.webPush.unsupportedInsecure");
    case "unsupported-ios-homescreen":
      return t("settings.host.webPush.unsupportedIos");
    case "unsupported-browser":
      return t("settings.host.webPush.unsupportedBrowser");
    case "permission-denied":
      return t("settings.host.webPush.permissionDenied");
    case "update-required":
      return t("settings.host.webPush.updateRequired");
    case "disconnected":
      return t("settings.host.webPush.disconnected");
    case "enabling":
      return t("settings.host.webPush.enablingHint");
    case "enabled":
      if (status.operation === "disabling") return t("settings.host.webPush.disablingHint");
      if (status.operation === "testing") return t("settings.host.webPush.testingHint");
      return t("settings.host.webPush.enabledHint");
    default:
      return t("settings.host.webPush.disabledHint");
  }
}

function HostWebPushSectionContent({ serverId, t }: { serverId: string; t: TFunction }) {
  const {
    status,
    isSupported,
    isEnabling,
    isDisabling,
    isTesting,
    error,
    enable,
    disable,
    sendTestNotification,
  } = useHostWebPush(serverId);

  const hintText = getHintText(status, t);

  const isEnabled = status.kind === "enabled";
  const canEnable = isSupported && status.kind === "disabled";
  let row1Error = error;
  if (status.kind === "disabled") {
    row1Error = status.error?.message ?? error;
  } else if (status.kind === "enabled" && status.error?.operation === "disable") {
    row1Error = status.error.message;
  }
  const testError =
    status.kind === "enabled" && status.error?.operation === "test" ? status.error.message : null;

  return (
    <SettingsSection
      title={t("settings.host.webPush.title", { defaultValue: "Web Push Notifications" })}
      testID="web-push-section"
    >
      <View style={settingsStyles.card}>
        <View style={settingsStyles.row}>
          <View style={settingsStyles.rowContent}>
            <Text style={settingsStyles.rowTitle}>
              {t("settings.host.webPush.label", { defaultValue: "Background notifications" })}
            </Text>
            <Text style={settingsStyles.rowHint}>{hintText}</Text>
            {row1Error ? <Text style={settingsStyles.rowError}>{row1Error}</Text> : null}
          </View>
          <View style={styles.actions}>
            {canEnable ? (
              <Button
                size="sm"
                variant="default"
                onPress={enable}
                loading={isEnabling}
                testID="web-push-enable-button"
              >
                {status.error?.operation === "enable"
                  ? t("common.retry", { defaultValue: "Retry" })
                  : t("settings.host.webPush.enable", { defaultValue: "Enable" })}
              </Button>
            ) : null}
            {isEnabled ? (
              <Button
                size="sm"
                variant="outline"
                onPress={disable}
                loading={isDisabling}
                testID="web-push-disable-button"
              >
                {status.error?.operation === "disable"
                  ? t("common.retry", { defaultValue: "Retry" })
                  : t("settings.host.webPush.disable", { defaultValue: "Disable" })}
              </Button>
            ) : null}
          </View>
        </View>

        {isEnabled ? (
          <View style={[settingsStyles.row, settingsStyles.rowBorder]}>
            <View style={settingsStyles.rowContent}>
              <Text style={settingsStyles.rowTitle}>
                {t("settings.host.webPush.testTitle", {
                  defaultValue: "Test notification",
                })}
              </Text>
              <Text style={settingsStyles.rowHint}>
                {t("settings.host.webPush.testHint", {
                  defaultValue: "Send a test notification to verify delivery on this device.",
                })}
              </Text>
              {testError ? <Text style={settingsStyles.rowError}>{testError}</Text> : null}
            </View>
            <View style={styles.actions}>
              <Button
                size="sm"
                variant="secondary"
                onPress={sendTestNotification}
                loading={isTesting}
                testID="web-push-test-button"
              >
                {t("settings.host.webPush.sendTest", { defaultValue: "Send test" })}
              </Button>
            </View>
          </View>
        ) : null}
      </View>
    </SettingsSection>
  );
}

const styles = StyleSheet.create((theme) => ({
  actions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
}));
