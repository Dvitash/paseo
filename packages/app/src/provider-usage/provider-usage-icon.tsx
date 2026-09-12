import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { getProviderIcon } from "@/components/provider-icons";
import { resolveProviderIconName } from "@/components/provider-icon-name";
import type { Theme } from "@/styles/theme";

interface ProviderUsageIconProps {
  iconKey: string;
  serverId?: string | null;
  size: number;
  color?: string;
  monogramBackground?: string;
}

function monogramLetter(providerId: string): string {
  const first = providerId.trim().charAt(0);
  return first ? first.toUpperCase() : "?";
}

// Usage slots must always render something recognizable, even for providers
// nobody vendored an icon for yet — a letter chip beats the generic bot.
function ProviderUsageIcon({
  iconKey,
  serverId,
  size,
  color = "",
  monogramBackground = "",
}: ProviderUsageIconProps) {
  const name = resolveProviderIconName(iconKey, serverId);
  if (name.kind === "bot") {
    return (
      <View
        style={[
          styles.monogram,
          { width: size, height: size, borderRadius: size * 0.28 },
          monogramBackground ? { backgroundColor: monogramBackground } : null,
        ]}
      >
        <Text style={[styles.monogramText, { fontSize: size * 0.58, color }]}>
          {monogramLetter(iconKey)}
        </Text>
      </View>
    );
  }
  const Icon = getProviderIcon(iconKey, serverId);
  return <Icon size={size} color={color} />;
}

export const ThemedProviderUsageIcon = withUnistyles(ProviderUsageIcon);

export const providerUsageIconColorMapping = (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
  monogramBackground: theme.colors.surfaceSidebarSelected,
});
const styles = StyleSheet.create((theme) => ({
  monogram: {
    alignItems: "center",
    justifyContent: "center",
  },
  monogramText: {
    fontWeight: theme.fontWeight.semibold,
    includeFontPadding: false,
    textAlign: "center",
  },
}));
