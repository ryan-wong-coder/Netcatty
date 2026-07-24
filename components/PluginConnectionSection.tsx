import React, { useEffect, useMemo, useRef, useState } from "react";
import { Plug, RotateCcw } from "lucide-react";
import type { Host, Identity, SSHKey } from "../types";
import { isEncryptedCredentialPlaceholder } from "../domain/credentials";
import {
  isPluginHostProtocol,
  pluginProtocolForProvider,
  sanitizePluginConnection,
} from "../domain/pluginConnection";
import { pluginConfigurationMatchesSchema } from "../domain/pluginConfigurationSchema";
import { pluginExtensionBridge } from "../application/state/pluginExtensionBridge";
import { HostDetailsSection } from "./host-details";
import { Button } from "./ui/button";
import { Combobox } from "./ui/combobox";

type Props = {
  form: Host;
  setForm: React.Dispatch<React.SetStateAction<Host>>;
  t: (key: string, params?: Record<string, unknown>) => string;
  onValidityChange: (valid: boolean) => void;
  identities: Identity[];
  keys: SSHKey[];
};

const localize = (value: unknown, fallback: string): string => {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object" || Array.isArray(value)) return fallback;
  const labels = value as Record<string, unknown>;
  const locale = navigator.language;
  const candidate = labels[locale] ?? labels[locale.split("-")[0]] ?? labels.en;
  return typeof candidate === "string" ? candidate : fallback;
};

export const PluginConnectionSection: React.FC<Props> = ({
  form,
  setForm,
  t,
  onValidityChange,
  identities,
  keys,
}) => {
  const [providers, setProviders] = useState<ReadonlyArray<NetcattyExtensionProviderContribution>>([]);
  const [authenticationProviders, setAuthenticationProviders] = useState<ReadonlyArray<NetcattyExtensionProviderContribution>>([]);
  const [configurationText, setConfigurationText] = useState(() => JSON.stringify(
    form.pluginConnection?.configuration === undefined ? {} : form.pluginConnection.configuration,
    null,
    2,
  ));
  const configurationTextRef = useRef(configurationText);
  const [configurationError, setConfigurationError] = useState<string | null>(null);
  const active = isPluginHostProtocol(form.protocol);
  const providerId = form.pluginConnection?.providerId ?? (active ? form.protocol.slice(7) : "");
  const selectedProvider = providers.find((entry) => entry.provider.id === providerId);
  const onValidityChangeRef = useRef(onValidityChange);
  onValidityChangeRef.current = onValidityChange;

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      pluginExtensionBridge.listProviders("connection"),
      pluginExtensionBridge.listProviders("authentication"),
    ]).then(([connections, authentications]) => {
      if (cancelled) return;
      setProviders(connections);
      setAuthenticationProviders(authentications);
    }).catch(() => {
      if (!cancelled) {
        setProviders([]);
        setAuthenticationProviders([]);
      }
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const configuration = form.pluginConnection?.configuration === undefined
      ? {}
      : form.pluginConnection.configuration;
    let localConfigurationMatches = false;
    try {
      localConfigurationMatches = JSON.stringify(JSON.parse(configurationTextRef.current)) === JSON.stringify(configuration);
    } catch {
      // Preserve an in-progress invalid edit until the selected host or provider changes.
    }
    if (!localConfigurationMatches) {
      const nextText = JSON.stringify(configuration, null, 2);
      configurationTextRef.current = nextText;
      setConfigurationText(nextText);
    }
    const structurallyValid = !active || Boolean(sanitizePluginConnection(form.pluginConnection, form.protocol));
    const schemaValid = selectedProvider?.provider.configurationSchema === undefined
      || pluginConfigurationMatchesSchema(selectedProvider.provider.configurationSchema, configuration);
    setConfigurationError(schemaValid ? null : t("hostDetails.plugin.configuration.schemaInvalid"));
    onValidityChangeRef.current(structurallyValid && schemaValid);
  }, [active, form.id, form.pluginConnection, form.protocol, selectedProvider, t]);

  const providerOptions = useMemo(() => providers.map((entry) => ({
    value: entry.provider.id,
    label: localize(entry.provider.label, entry.provider.id),
  })), [providers]);
  const authenticationOptions = useMemo(() => [
    { value: "", label: t("hostDetails.plugin.authentication.none") },
    ...authenticationProviders.map((entry) => ({
      value: entry.provider.id,
      label: localize(entry.provider.label, entry.provider.id),
    })),
  ], [authenticationProviders, t]);
  const credentialOptions = useMemo(() => {
    const options = [
      { value: "", label: t("hostDetails.plugin.credential.none") },
      ...identities.flatMap((identity) => identity.password
        && !isEncryptedCredentialPlaceholder(identity.password)
        && new TextEncoder().encode(identity.password).byteLength <= 64 * 1024
        ? [{
            value: identity.id,
            label: identity.label,
            sublabel: t("hostDetails.plugin.credential.password"),
          }]
        : []),
      ...keys.flatMap((key) => key.privateKey
        && !isEncryptedCredentialPlaceholder(key.privateKey)
        && new TextEncoder().encode(key.privateKey).byteLength <= 64 * 1024
        ? [{
            value: key.id,
            label: key.label,
            sublabel: t("hostDetails.plugin.credential.privateKey"),
          }]
        : []),
    ];
    const selected = form.pluginConnection?.credentialId;
    if (selected && !options.some((option) => option.value === selected)) {
      options.push({
        value: selected,
        label: t("hostDetails.plugin.credential.unavailable"),
        sublabel: selected,
      });
    }
    return options;
  }, [form.pluginConnection?.credentialId, identities, keys, t]);
  const installed = providers.some((entry) => entry.provider.id === providerId);

  if (!active && providers.length === 0) return null;

  const updateConfiguration = (text: string) => {
    configurationTextRef.current = text;
    setConfigurationText(text);
    try {
      const configuration = JSON.parse(text) as unknown;
      if (configuration === undefined) throw new Error("empty");
      const nextConnection = form.pluginConnection ? { ...form.pluginConnection, configuration } : undefined;
      if (!sanitizePluginConnection(nextConnection, form.protocol)) throw new Error("unsafe");
      if (selectedProvider?.provider.configurationSchema !== undefined
        && !pluginConfigurationMatchesSchema(selectedProvider.provider.configurationSchema, configuration)) {
        setConfigurationError(t("hostDetails.plugin.configuration.schemaInvalid"));
        onValidityChange(false);
        return;
      }
      setConfigurationError(null);
      onValidityChange(true);
      setForm((previous) => previous.pluginConnection ? ({
        ...previous,
        pluginConnection: { ...previous.pluginConnection, configuration },
      }) : previous);
    } catch {
      setConfigurationError(t("hostDetails.plugin.configuration.invalid"));
      onValidityChange(false);
    }
  };

  return (
    <HostDetailsSection
      icon={<Plug size={14} className="text-muted-foreground" />}
      title={t("hostDetails.plugin.title")}
      hint={active && !installed ? t("hostDetails.plugin.unavailable") : undefined}
    >
      <Combobox
        options={providerOptions}
        value={providerId}
        onValueChange={(nextProviderId) => {
          const configuration = {};
          const nextProvider = providers.find((entry) => entry.provider.id === nextProviderId);
          const schemaValid = nextProvider?.provider.configurationSchema === undefined
            || pluginConfigurationMatchesSchema(nextProvider.provider.configurationSchema, configuration);
          setForm((previous) => ({
            ...previous,
            protocol: pluginProtocolForProvider(nextProviderId),
            pluginConnection: { providerId: nextProviderId, configuration },
          }));
          setConfigurationText("{}");
          configurationTextRef.current = "{}";
          setConfigurationError(schemaValid ? null : t("hostDetails.plugin.configuration.schemaInvalid"));
          onValidityChange(schemaValid);
        }}
        placeholder={t("hostDetails.plugin.provider.placeholder")}
        emptyText={t("hostDetails.plugin.provider.empty")}
      />
      {active ? (
        <>
          <Combobox
            options={authenticationOptions}
            value={form.pluginConnection?.authenticationProviderId ?? ""}
            onValueChange={(authenticationProviderId) => setForm((previous) => previous.pluginConnection ? ({
              ...previous,
              pluginConnection: {
                ...previous.pluginConnection,
                ...(authenticationProviderId ? { authenticationProviderId } : { authenticationProviderId: undefined }),
              },
            }) : previous)}
            placeholder={t("hostDetails.plugin.authentication.placeholder")}
          />
          <Combobox
            options={credentialOptions}
            value={form.pluginConnection?.credentialId ?? ""}
            onValueChange={(credentialId) => setForm((previous) => previous.pluginConnection ? ({
              ...previous,
              pluginConnection: {
                ...previous.pluginConnection,
                ...(credentialId ? { credentialId } : { credentialId: undefined }),
              },
            }) : previous)}
            placeholder={t("hostDetails.plugin.credential.placeholder")}
          />
          <textarea
            value={configurationText}
            onChange={(event) => updateConfiguration(event.target.value)}
            spellCheck={false}
            className="min-h-32 w-full resize-y rounded-md border border-border bg-background px-3 py-2 font-mono text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label={t("hostDetails.plugin.configuration.label")}
          />
          {configurationError ? <p className="text-xs text-destructive">{configurationError}</p> : null}
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              setForm((previous) => ({
                ...previous,
                protocol: "ssh",
                pluginConnection: undefined,
              }));
              onValidityChange(true);
            }}
          >
            <RotateCcw size={14} className="mr-2" />
            {t("hostDetails.plugin.useSsh")}
          </Button>
        </>
      ) : null}
    </HostDetailsSection>
  );
};
