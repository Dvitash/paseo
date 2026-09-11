import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { MutableDaemonConfig, MutableDaemonConfigPatch } from "@getpaseo/protocol/messages";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { DropdownTrigger } from "@/components/ui/dropdown-trigger";
import { EditingTextInput, type EditingTextInputHandle } from "@/components/ui/text-input";
import { Switch } from "@/components/ui/switch";
import { SettingsSection } from "@/components/settings/headings/settings-section";
import { useAppSettings } from "@/hooks/use-settings";
import { useHostRuntimeClient, useHostRuntimeIsConnected, useHosts } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { settingsStyles } from "@/styles/settings";
import { getVoiceReadinessState } from "@/utils/server-info-capabilities";
import { isWeb } from "@/constants/platform";
import type { HostProfile } from "@/types/host-connection";

type DictationProvider = "local" | "openai";

const DICTATION_PROVIDERS: DictationProvider[] = ["local", "openai"];

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function dictationProviderLabelKey(provider: DictationProvider): string {
  return `settings.voice.dictation.provider.${provider}`;
}

// ---------------------------------------------------------------------------
// Microphone input device (web / Electron)
// ---------------------------------------------------------------------------

interface AudioInputDevice {
  deviceId: string;
  label: string;
}

async function enumerateAudioInputDevices(): Promise<AudioInputDevice[]> {
  if (typeof navigator === "undefined" || !navigator.mediaDevices) {
    return [];
  }
  if (typeof navigator.mediaDevices.enumerateDevices !== "function") {
    return [];
  }
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices
    .filter((device) => device.kind === "audioinput")
    .map((device) => ({ deviceId: device.deviceId, label: device.label }));
}
function AudioInputDeviceMenuItem({
  device,
  label,
  selected,
  onSelect,
}: {
  device: AudioInputDevice;
  label: string;
  selected: boolean;
  onSelect: (deviceId: string) => void;
}) {
  const handleSelect = useCallback(() => onSelect(device.deviceId), [device.deviceId, onSelect]);
  return (
    <DropdownMenuItem selected={selected} onSelect={handleSelect}>
      {label}
    </DropdownMenuItem>
  );
}
function resolveDictationStatusText(input: {
  isConnected: boolean;
  readiness: { enabled: boolean; reason: string } | null;
  t: TFunction;
}): string {
  const { isConnected, readiness, t } = input;
  if (!isConnected) {
    return t("settings.voice.dictation.offline");
  }
  if (readiness) {
    return readiness.enabled
      ? t("settings.voice.dictation.ready")
      : readiness.reason.trim() || t("settings.voice.dictation.notReady");
  }
  return t("settings.voice.dictation.statusUnknown");
}

function MicrophoneSection() {
  const { t } = useTranslation();
  const { settings, updateSettings } = useAppSettings();
  const selectedDeviceId = settings.dictationInputDeviceId;
  const [devices, setDevices] = useState<AudioInputDevice[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isRequesting, setIsRequesting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refreshDevices = useCallback(async () => {
    setIsLoading(true);
    try {
      setDevices(await enumerateAudioInputDevices());
      setError(null);
    } catch (cause) {
      setError(t("settings.voice.microphone.accessError", { message: errorMessage(cause) }));
    } finally {
      setIsLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void refreshDevices();
  }, [refreshDevices]);

  const requestAccess = useCallback(async () => {
    if (typeof navigator?.mediaDevices?.getUserMedia !== "function") {
      setError(t("settings.voice.microphone.accessUnavailable"));
      return;
    }
    setIsRequesting(true);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      for (const track of stream.getTracks()) {
        track.stop();
      }
      setError(null);
      await refreshDevices();
    } catch (cause) {
      setError(t("settings.voice.microphone.accessError", { message: errorMessage(cause) }));
    } finally {
      setIsRequesting(false);
    }
  }, [refreshDevices, t]);

  const handleSelectDevice = useCallback(
    (deviceId: string | null) => {
      void updateSettings({ dictationInputDeviceId: deviceId });
    },
    [updateSettings],
  );
  const handleSelectDefault = useCallback(() => handleSelectDevice(null), [handleSelectDevice]);
  const handleRequestAccess = useCallback(() => {
    void requestAccess();
  }, [requestAccess]);

  const deviceLabel = useCallback(
    (device: AudioInputDevice, index: number): string =>
      device.label.trim() || t("settings.voice.microphone.deviceFallback", { index: index + 1 }),
    [t],
  );

  const selectedLabel = useMemo(() => {
    if (!selectedDeviceId) {
      return t("settings.voice.microphone.systemDefault");
    }
    const index = devices.findIndex((device) => device.deviceId === selectedDeviceId);
    if (index === -1) {
      return t("settings.voice.microphone.deviceUnavailable");
    }
    return deviceLabel(devices[index], index);
  }, [deviceLabel, devices, selectedDeviceId, t]);

  const labelsHidden = devices.some((device) => !device.label.trim());
  const showAccessRow = !isLoading && (devices.length === 0 || labelsHidden);

  let accessHint: string | null = null;
  if (showAccessRow) {
    accessHint =
      devices.length === 0
        ? t("settings.voice.microphone.accessNoDevices")
        : t("settings.voice.microphone.accessLabelsHidden");
  }

  return (
    <SettingsSection title={t("settings.voice.title")}>
      <View style={settingsStyles.card}>
        <View style={settingsStyles.row}>
          <View style={settingsStyles.rowContent}>
            <Text style={settingsStyles.rowTitle}>{t("settings.voice.microphone.label")}</Text>
            <Text style={settingsStyles.rowHint}>{t("settings.voice.microphone.description")}</Text>
          </View>
          <DropdownMenu>
            <DropdownTrigger
              accessibilityRole="button"
              accessibilityLabel={`${t("settings.voice.microphone.label")}: ${selectedLabel}`}
              style={styles.trigger}
            >
              <Text style={styles.triggerText} numberOfLines={1}>
                {selectedLabel}
              </Text>
            </DropdownTrigger>
            <DropdownMenuContent side="bottom" align="end" width={280}>
              <DropdownMenuItem selected={!selectedDeviceId} onSelect={handleSelectDefault}>
                {t("settings.voice.microphone.systemDefault")}
              </DropdownMenuItem>
              {devices.map((device, index) => (
                <AudioInputDeviceMenuItem
                  key={device.deviceId}
                  device={device}
                  label={deviceLabel(device, index)}
                  selected={selectedDeviceId === device.deviceId}
                  onSelect={handleSelectDevice}
                />
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </View>
        {showAccessRow ? (
          <View style={[settingsStyles.row, settingsStyles.rowBorder]}>
            <View style={settingsStyles.rowContent}>
              <Text style={settingsStyles.rowTitle}>
                {t("settings.voice.microphone.accessLabel")}
              </Text>
              {accessHint ? <Text style={settingsStyles.rowHint}>{accessHint}</Text> : null}
              {error ? <Text style={settingsStyles.rowError}>{error}</Text> : null}
            </View>
            <Button
              variant="secondary"
              size="sm"
              onPress={handleRequestAccess}
              disabled={isRequesting}
            >
              {isRequesting
                ? t("settings.voice.microphone.requesting")
                : t("settings.voice.microphone.allowAccess")}
            </Button>
          </View>
        ) : null}
      </View>
    </SettingsSection>
  );
}

function MicrophoneManagedBySystemSection() {
  const { t } = useTranslation();
  return (
    <SettingsSection title={t("settings.voice.title")}>
      <View style={settingsStyles.card}>
        <View style={settingsStyles.row}>
          <View style={settingsStyles.rowContent}>
            <Text style={settingsStyles.rowTitle}>{t("settings.voice.microphone.label")}</Text>
            <Text style={settingsStyles.rowHint}>
              {t("settings.voice.microphone.managedDescription")}
            </Text>
          </View>
        </View>
      </View>
    </SettingsSection>
  );
}

// ---------------------------------------------------------------------------
// Per-host dictation
// ---------------------------------------------------------------------------

interface HostDictationState {
  config: MutableDaemonConfig | null;
  isLoading: boolean;
  isSaving: boolean;
  needsRestart: boolean;
  error: string | null;
  patch: (patch: MutableDaemonConfigPatch) => Promise<void>;
}

function useHostDictationState(serverId: string, canConfigure: boolean): HostDictationState {
  const { t } = useTranslation();
  const client = useHostRuntimeClient(serverId);
  const isConnected = useHostRuntimeIsConnected(serverId);
  const [config, setConfig] = useState<MutableDaemonConfig | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [needsRestart, setNeedsRestart] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!client || !isConnected || !canConfigure) {
      setConfig(null);
      setIsLoading(false);
      setNeedsRestart(false);
      return;
    }
    let cancelled = false;
    setIsLoading(true);
    void (async () => {
      try {
        const result = await client.getDaemonConfig();
        if (cancelled) return;
        setConfig(result.config);
        setError(null);
      } catch (cause) {
        if (cancelled) return;
        setError(t("settings.voice.dictation.saveFailed", { message: errorMessage(cause) }));
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, isConnected, canConfigure, t]);

  const patch = useCallback(
    async (nextPatch: MutableDaemonConfigPatch) => {
      if (!client) return;
      setIsSaving(true);
      try {
        const result = await client.patchDaemonConfig(nextPatch);
        setConfig(result.config);
        setNeedsRestart((result.restartRequiredPaths?.length ?? 0) > 0);
        setError(null);
      } catch (cause) {
        setError(t("settings.voice.dictation.saveFailed", { message: errorMessage(cause) }));
      } finally {
        setIsSaving(false);
      }
    },
    [client, t],
  );

  return { config, isLoading, isSaving, needsRestart, error, patch };
}

function DictationProviderMenuItem({
  provider,
  selected,
  onSelect,
}: {
  provider: DictationProvider;
  selected: boolean;
  onSelect: (provider: DictationProvider) => void;
}) {
  const { t } = useTranslation();
  const handleSelect = useCallback(() => onSelect(provider), [onSelect, provider]);
  return (
    <DropdownMenuItem selected={selected} onSelect={handleSelect}>
      {t(dictationProviderLabelKey(provider))}
    </DropdownMenuItem>
  );
}

function DictationAdvancedRows({
  serverId,
  dictation,
  patch,
}: {
  serverId: string;
  dictation: NonNullable<NonNullable<MutableDaemonConfig["features"]>["dictation"]> | undefined;
  patch: (patch: MutableDaemonConfigPatch) => Promise<void>;
}) {
  const { t } = useTranslation();
  const languageInputRef = useRef<EditingTextInputHandle | null>(null);

  const rawProvider = dictation?.stt?.provider;
  // Unknown providers from a newer daemon display raw and select nothing —
  // never alias to a known value the user could then "save" over it.
  const provider: DictationProvider | null =
    rawProvider === "openai" || rawProvider === "local" ? rawProvider : null;
  const providerLabel =
    provider !== null
      ? t(dictationProviderLabelKey(provider))
      : (rawProvider ?? t(dictationProviderLabelKey("local")));
  const handleProviderChange = useCallback(
    (next: DictationProvider) => {
      void patch({ features: { dictation: { stt: { provider: next } } } });
    },
    [patch],
  );

  const storedLanguage = dictation?.stt?.language ?? "";
  const commitLanguage = useCallback(() => {
    const input = languageInputRef.current;
    const next = (input?.getText() ?? storedLanguage).trim();
    if (!next) {
      input?.replaceText(storedLanguage);
      return;
    }
    if (next === storedLanguage) return;
    void patch({ features: { dictation: { stt: { language: next } } } });
  }, [patch, storedLanguage]);

  return (
    <>
      <View style={[settingsStyles.row, settingsStyles.rowBorder]}>
        <View style={settingsStyles.rowContent}>
          <Text style={settingsStyles.rowTitle}>
            {t("settings.voice.dictation.provider.label")}
          </Text>
          <Text style={settingsStyles.rowHint}>
            {t("settings.voice.dictation.provider.description")}
          </Text>
        </View>
        <DropdownMenu>
          <DropdownTrigger
            accessibilityLabel={`${t("settings.voice.dictation.provider.label")}: ${providerLabel}`}
            style={styles.trigger}
          >
            <Text style={styles.triggerText} numberOfLines={1}>
              {providerLabel}
            </Text>
          </DropdownTrigger>
          <DropdownMenuContent side="bottom" align="end" width={240}>
            {DICTATION_PROVIDERS.map((value) => (
              <DictationProviderMenuItem
                key={value}
                provider={value}
                selected={provider === value}
                onSelect={handleProviderChange}
              />
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </View>
      {/* Parakeet ignores `language` (v2 is English-only, v3 auto-detects);
          only OpenAI honors it. */}
      {provider === "openai" ? (
        <View style={[settingsStyles.row, settingsStyles.rowBorder]}>
          <View style={settingsStyles.rowContent}>
            <Text style={settingsStyles.rowTitle}>
              {t("settings.voice.dictation.language.label")}
            </Text>
            <Text style={settingsStyles.rowHint}>
              {t("settings.voice.dictation.language.description")}
            </Text>
          </View>
          <EditingTextInput
            ref={languageInputRef}
            initialValue={storedLanguage}
            onBlur={commitLanguage}
            onSubmitEditing={commitLanguage}
            autoCapitalize="none"
            autoCorrect={false}
            placeholder={t("settings.voice.dictation.language.placeholder")}
            style={styles.languageInput}
            accessibilityLabel={t("settings.voice.dictation.language.accessibilityLabel")}
            testID={`voice-dictation-language-${serverId}`}
          />
        </View>
      ) : null}
    </>
  );
}
function HostDictationCard({ host }: { host: HostProfile }) {
  const { t } = useTranslation();
  const serverId = host.serverId;
  const isConnected = useHostRuntimeIsConnected(serverId);
  const serverInfo = useSessionStore((state) => state.sessions[serverId]?.serverInfo ?? null);
  // Older daemons advertise capabilities.voice.dictation but silently drop
  // `features` patches; only dictationConfig proves the patch is honored.
  const supportsDictationConfig = serverInfo?.features?.dictationConfig === true;
  const { config, isLoading, isSaving, needsRestart, error, patch } = useHostDictationState(
    serverId,
    supportsDictationConfig,
  );

  const readiness = useMemo(
    () => getVoiceReadinessState({ serverInfo, mode: "dictation" }),
    [serverInfo],
  );

  const dictation = config?.features?.dictation;
  const enabled = dictation?.enabled ?? readiness?.enabled ?? false;
  const updateRequired = isConnected && !supportsDictationConfig;

  const statusText = resolveDictationStatusText({ isConnected, readiness, t });

  const handleEnabledChange = useCallback(
    (next: boolean) => {
      void patch({ features: { dictation: { enabled: next } } });
    },
    [patch],
  );

  return (
    <View style={styles.hostCard}>
      <View style={settingsStyles.card}>
        <View style={settingsStyles.row}>
          <View style={settingsStyles.rowContent}>
            <Text style={settingsStyles.rowTitle} numberOfLines={1}>
              {host.label}
            </Text>
            <Text style={settingsStyles.rowHint}>{statusText}</Text>
            {isLoading ? (
              <Text style={settingsStyles.rowHint}>{t("settings.voice.dictation.loading")}</Text>
            ) : null}
            {needsRestart ? (
              <Text style={styles.restartHint}>
                {t("settings.voice.dictation.restartRequired")}
              </Text>
            ) : null}
            {updateRequired ? (
              <Text style={styles.restartHint}>{t("settings.voice.dictation.updateRequired")}</Text>
            ) : null}
            {error ? <Text style={settingsStyles.rowError}>{error}</Text> : null}
          </View>
          <Switch
            value={enabled}
            onValueChange={handleEnabledChange}
            disabled={
              !isConnected || !supportsDictationConfig || isLoading || config === null || isSaving
            }
            accessibilityLabel={`${t("settings.voice.dictation.enable")}: ${host.label}`}
            testID={`voice-dictation-switch-${serverId}`}
          />
        </View>
        {config !== null && supportsDictationConfig ? (
          <DictationAdvancedRows serverId={serverId} dictation={dictation} patch={patch} />
        ) : null}
      </View>
    </View>
  );
}

function DictationHostsSection() {
  const { t } = useTranslation();
  const hosts = useHosts();
  return (
    <SettingsSection title={t("settings.voice.dictation.title")}>
      {hosts.length === 0 ? (
        <View style={settingsStyles.card}>
          <View style={settingsStyles.row}>
            <View style={settingsStyles.rowContent}>
              <Text style={settingsStyles.rowHint}>{t("settings.voice.dictation.noHosts")}</Text>
            </View>
          </View>
        </View>
      ) : (
        hosts.map((host) => <HostDictationCard key={host.serverId} host={host} />)
      )}
    </SettingsSection>
  );
}

export function VoiceSection() {
  return (
    <>
      {isWeb ? <MicrophoneSection /> : <MicrophoneManagedBySystemSection />}
      <DictationHostsSection />
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  trigger: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingVertical: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    flexShrink: 1,
  },
  triggerText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
  },
  hostCard: {
    marginBottom: theme.spacing[3],
  },
  restartHint: {
    color: theme.colors.statusWarning,
    fontSize: theme.fontSize.sm,
    marginTop: theme.spacing[1],
  },
  languageInput: {
    width: 112,
    minHeight: 36,
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface2,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    textAlign: "right",
  },
}));
