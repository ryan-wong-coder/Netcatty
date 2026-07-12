import {
  ArrowLeft,
  ChevronDown,
  Eye,
  EyeOff,
  Globe,
  Key,
  Lock,
  Plus,
  Terminal as TerminalIcon,
  User,
} from "lucide-react";
import React, { useMemo, useState } from "react";
import { useI18n } from "../application/i18n/I18nProvider";
import type { QuickConnectTarget } from "../domain/quickConnect";
import {
  buildQuickConnectHost,
  getQuickConnectDefaultPort,
  type QuickConnectProtocol,
} from "../domain/quickConnectHost";
import { formatHostPort } from "../domain/host";
import { cn } from "../lib/utils";
import { Host, Identity, SSHKey } from "../types";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Dropdown, DropdownContent, DropdownTrigger } from "./ui/dropdown";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import { ScrollArea } from "./ui/scroll-area";

// Wizard steps
type WizardStep = "protocol" | "username" | "knownhost" | "auth";

interface QuickConnectWizardProps {
  open: boolean;
  target: QuickConnectTarget;
  keys: SSHKey[];
  identities: Identity[];
  warnings?: string[];
  onConnect: (host: Host) => void;
  onSaveHost?: (host: Host) => void;
  onAddKey?: () => void;
  onClose: () => void;
}

const QuickConnectWizard: React.FC<QuickConnectWizardProps> = ({
  open,
  target,
  keys,
  identities,
  warnings,
  onConnect,
  onSaveHost,
  onAddKey,
  onClose,
}) => {
  const { t } = useI18n();
  // Wizard state
  const [step, setStep] = useState<WizardStep>("protocol");
  const [protocol, setProtocol] = useState<QuickConnectProtocol>("ssh");
  const [username, setUsername] = useState(target.username || "");
  const [port, setPort] = useState<number>(target.port || 22);

  // Known host verification state
  const [knownHostInfo, setKnownHostInfo] = useState<{
    keyType: string;
    fingerprint: string;
  } | null>(null);

  // Auth state
  const [authMethod, setAuthMethod] = useState<"password" | "key" | "certificate">("password");
  const [password, setPassword] = useState("");
  const [selectedKeyId, setSelectedKeyId] = useState<string | null>(null);
  const [selectedIdentityId, setSelectedIdentityId] = useState<string | null>(null);
  const [identityPickerOpen, setIdentityPickerOpen] = useState(false);
  const [saveOptionsOpen, setSaveOptionsOpen] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const selectedIdentity = useMemo(
    () => identities.find((identity) => identity.id === selectedIdentityId),
    [identities, selectedIdentityId],
  );

  // Reset state when target changes
  React.useEffect(() => {
    if (open) {
      setStep("protocol");
      setProtocol("ssh");
      setUsername(target.username || "");
      setPort(target.port || 22);
      setPassword("");
      setSelectedKeyId(null);
      setSelectedIdentityId(null);
      setSaveOptionsOpen(false);
      setShowPassword(false);
      setKnownHostInfo(null);
    }
  }, [open, target]);

  // Handle protocol selection
  const handleProtocolSelect = (proto: QuickConnectProtocol) => {
    setProtocol(proto);
    if (proto === "telnet") {
      setSelectedIdentityId(null);
      setAuthMethod("password");
    }
    // Update port to default for protocol if unchanged
    if (port === getQuickConnectDefaultPort(protocol)) {
      setPort(getQuickConnectDefaultPort(proto));
    }
  };

  const clearSelectedIdentity = () => {
    setSelectedIdentityId(null);
    setAuthMethod("password");
    setPassword("");
    setSelectedKeyId(null);
  };

  // Navigate to next step
  const handleContinue = () => {
    switch (step) {
      case "protocol":
        // Always go to username step to let user confirm/edit username
        setStep("username");
        break;
      case "username":
        setStep("auth");
        break;
      case "knownhost":
        setStep("auth");
        break;
      case "auth":
        handleConnect();
        break;
    }
  };

  // Navigate back
  const handleBack = () => {
    switch (step) {
      case "username":
        setStep("protocol");
        break;
      case "knownhost":
        setStep("username");
        break;
      case "auth":
        // Always go back to username step
        setStep("username");
        break;
    }
  };

  // Create host and connect
  const handleConnect = (save = false) => {
    const tempHost = buildQuickConnectHost({
      target,
      protocol,
      port,
      username,
      authMethod,
      password,
      selectedKeyId,
      selectedIdentity,
      save,
    });

    if (save && onSaveHost) {
      onSaveHost(tempHost);
    }

    onConnect(tempHost);
    onClose();
  };

  // Check if can proceed
  const canProceed = useMemo(() => {
    switch (step) {
      case "protocol":
        return true;
      case "username":
        return username.trim().length > 0;
      case "knownhost":
        return true;
      case "auth":
        if (selectedIdentity) return true;
        if (authMethod === "password") {
          // Whitespace-only passwords are valid SSH secrets (issue #2036).
          return password.length > 0;
        }
        return !!selectedKeyId;
    }
  }, [step, username, authMethod, password, selectedKeyId, selectedIdentity]);

  // Render protocol selection step
  const renderProtocolStep = () => (
    <div className="space-y-4">
      <h3 className="text-base font-semibold">{t("protocolSelect.chooseProtocol")}</h3>
      <div className="space-y-3">
        {/* SSH */}
        <button
          className={cn(
            "w-full flex items-center justify-between px-4 py-3 rounded-xl border-2 transition-all text-left",
            protocol === "ssh"
              ? "border-primary bg-primary/5"
              : "border-border/60 hover:border-border hover:bg-secondary/50",
          )}
          onClick={() => handleProtocolSelect("ssh")}
        >
          <div className="flex items-center gap-3">
            <div
              className={cn(
                "h-10 w-10 rounded-lg flex items-center justify-center",
                protocol === "ssh"
                  ? "bg-primary/20 text-primary"
                  : "bg-muted text-muted-foreground",
              )}
            >
              <TerminalIcon size={18} />
            </div>
            <div>
              <div className="font-medium">SSH</div>
              <div className="text-xs text-muted-foreground font-mono">
                ssh {target.hostname}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">{t("protocolSelect.port")}</span>
            <Input
              type="number"
              value={protocol === "ssh" ? port : 22}
              onChange={(e) => {
                setPort(parseInt(e.target.value) || 22);
                setProtocol("ssh");
              }}
              onClick={(e) => e.stopPropagation()}
              className="w-16 h-7 text-xs text-center"
              min={1}
              max={65535}
            />
          </div>
        </button>

        {/* Mosh */}
        <button
          className={cn(
            "w-full flex items-center justify-between px-4 py-3 rounded-xl border-2 transition-all text-left",
            protocol === "mosh"
              ? "border-primary bg-primary/5"
              : "border-border/60 hover:border-border hover:bg-secondary/50",
          )}
          onClick={() => handleProtocolSelect("mosh")}
        >
          <div className="flex items-center gap-3">
            <div
              className={cn(
                "h-10 w-10 rounded-lg flex items-center justify-center",
                protocol === "mosh"
                  ? "bg-primary/20 text-primary"
                  : "bg-muted text-muted-foreground",
              )}
            >
              <Globe size={18} />
            </div>
            <div>
              <div className="font-medium">Mosh</div>
              <div className="text-xs text-muted-foreground font-mono">
                mosh {target.hostname}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">{t("protocolSelect.port")}</span>
            <Input
              type="number"
              value={protocol === "mosh" ? port : 22}
              onChange={(e) => {
                setPort(parseInt(e.target.value) || 22);
                setProtocol("mosh");
              }}
              onClick={(e) => e.stopPropagation()}
              className="w-16 h-7 text-xs text-center"
              min={1}
              max={65535}
            />
          </div>
        </button>

        {/* Eternal Terminal */}
        <button
          className={cn(
            "w-full flex items-center justify-between px-4 py-3 rounded-xl border-2 transition-all text-left",
            protocol === "et"
              ? "border-primary bg-primary/5"
              : "border-border/60 hover:border-border hover:bg-secondary/50",
          )}
          onClick={() => handleProtocolSelect("et")}
        >
          <div className="flex items-center gap-3">
            <div
              className={cn(
                "h-10 w-10 rounded-lg flex items-center justify-center",
                protocol === "et"
                  ? "bg-primary/20 text-primary"
                  : "bg-muted text-muted-foreground",
              )}
            >
              <Globe size={18} />
            </div>
            <div>
              <div className="font-medium">Eternal Terminal</div>
              <div className="text-xs text-muted-foreground font-mono">
                et {target.hostname}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">{t("protocolSelect.port")}</span>
            <Input
              type="number"
              value={protocol === "et" ? port : 22}
              onChange={(e) => {
                setPort(parseInt(e.target.value) || 22);
                setProtocol("et");
              }}
              onClick={(e) => e.stopPropagation()}
              className="w-16 h-7 text-xs text-center"
              min={1}
              max={65535}
            />
          </div>
        </button>

        {/* Telnet */}
        <button
          className={cn(
            "w-full flex items-center justify-between px-4 py-3 rounded-xl border-2 transition-all text-left",
            protocol === "telnet"
              ? "border-primary bg-primary/5"
              : "border-border/60 hover:border-border hover:bg-secondary/50",
          )}
          onClick={() => handleProtocolSelect("telnet")}
        >
          <div className="flex items-center gap-3">
            <div
              className={cn(
                "h-10 w-10 rounded-lg flex items-center justify-center",
                protocol === "telnet"
                  ? "bg-primary/20 text-primary"
                  : "bg-muted text-muted-foreground",
              )}
            >
              <TerminalIcon size={18} />
            </div>
            <div>
              <div className="font-medium">Telnet</div>
              <div className="text-xs text-muted-foreground font-mono">
                telnet {target.hostname}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">{t("protocolSelect.port")}</span>
            <Input
              type="number"
              value={protocol === "telnet" ? port : 23}
              onChange={(e) => {
                setPort(parseInt(e.target.value) || 23);
                setProtocol("telnet");
              }}
              onClick={(e) => e.stopPropagation()}
              className="w-16 h-7 text-xs text-center"
              min={1}
              max={65535}
            />
          </div>
        </button>
      </div>
    </div>
  );

  // Render username step
  const renderUsernameStep = () => (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="quick-username">{t("terminal.auth.username")}</Label>
        <Input
          id="quick-username"
          value={username}
          onChange={(e) => {
            setUsername(e.target.value);
            if (selectedIdentityId) clearSelectedIdentity();
          }}
          placeholder={t("terminal.auth.username.placeholder")}
          autoFocus
          onKeyDown={(e) => {
            if (e.key === "Enter" && username.trim()) {
              handleContinue();
            }
          }}
        />
      </div>
      {renderIdentityPicker()}
    </div>
  );

  // Render known host verification step
  const renderKnownHostStep = () => (
    <div className="space-y-4">
      <h3 className="text-base font-semibold text-amber-600 dark:text-amber-500">
        {t("quickConnect.knownHost.title")}
      </h3>
      <div className="space-y-2 text-sm text-muted-foreground">
        <p>{t("quickConnect.knownHost.authenticity", { hostname: target.hostname })}</p>
        {knownHostInfo && (
          <>
            <p className="font-medium text-foreground">
              {t("quickConnect.knownHost.fingerprintLabel", { keyType: knownHostInfo.keyType })}
            </p>
            <p className="font-mono text-xs bg-muted p-2 rounded break-all">
              {knownHostInfo.fingerprint}
            </p>
          </>
        )}
        <p>{t("quickConnect.knownHost.addQuestion")}</p>
      </div>
    </div>
  );

  const renderIdentityPicker = () => identities.length > 0 && protocol !== "telnet" ? (
    <div className="space-y-2">
          <Label>{t("quickConnect.identity.label")}</Label>
          <Popover open={identityPickerOpen} onOpenChange={setIdentityPickerOpen}>
            <PopoverTrigger asChild>
              <button className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg border border-border/50 hover:bg-secondary/50 text-left">
                <div className="h-8 w-8 rounded-lg flex items-center justify-center bg-primary/20 text-primary">
                  <User size={14} />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium truncate">
                    {selectedIdentity?.label || t("quickConnect.identity.manual")}
                  </div>
                  {selectedIdentity && (
                    <div className="text-xs text-muted-foreground truncate">
                      {selectedIdentity.username}
                    </div>
                  )}
                </div>
                <ChevronDown size={16} className="text-muted-foreground" />
              </button>
            </PopoverTrigger>
            <PopoverContent
              className="p-1"
              align="start"
              style={{ width: "var(--radix-popover-trigger-width)" }}
            >
              <div className="max-h-60 overflow-y-auto">
                <button
                  className={cn(
                    "w-full px-3 py-2 text-sm text-left rounded-md",
                    !selectedIdentityId ? "bg-primary/10 text-primary" : "hover:bg-secondary/80",
                  )}
                  onClick={() => {
                    if (selectedIdentityId) clearSelectedIdentity();
                    setIdentityPickerOpen(false);
                  }}
                >
                  {t("quickConnect.identity.manual")}
                </button>
                {identities.map((identity) => (
                  <button
                    key={identity.id}
                    className={cn(
                      "w-full px-3 py-2 text-left rounded-md",
                      selectedIdentityId === identity.id
                        ? "bg-primary/10 text-primary"
                        : "hover:bg-secondary/80",
                    )}
                    onClick={() => {
                      setSelectedIdentityId(identity.id);
                      setUsername(identity.username);
                      setAuthMethod(identity.authMethod);
                      setIdentityPickerOpen(false);
                    }}
                  >
                    <div className="text-sm font-medium truncate">{identity.label}</div>
                    <div className="text-xs text-muted-foreground truncate">{identity.username}</div>
                  </button>
                ))}
              </div>
            </PopoverContent>
          </Popover>
    </div>
  ) : null;

  // Render auth step
  const renderAuthStep = () => (
    <div className="space-y-4">
      {renderIdentityPicker()}

      {!selectedIdentity && (
        <>
      {/* Auth method tabs */}
      <div className="flex gap-1 p-1 bg-secondary/80 rounded-lg border border-border/60">
        <button
          className={cn(
            "flex-1 flex items-center justify-center gap-2 py-2 text-sm font-medium rounded-md transition-all",
            authMethod === "password"
              ? "bg-primary text-primary-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground hover:bg-secondary",
          )}
          onClick={() => setAuthMethod("password")}
        >
          <Lock size={14} />
          {t("terminal.auth.password")}
        </button>
        <button
          className={cn(
            "flex-1 flex items-center justify-center gap-2 py-2 text-sm font-medium rounded-md transition-all",
            authMethod === "key"
              ? "bg-primary text-primary-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground hover:bg-secondary",
          )}
          onClick={() => setAuthMethod("key")}
        >
          <Key size={14} />
          {t("terminal.auth.sshKey")}
        </button>
      </div>

      {/* Password field */}
      {authMethod === "password" && (
        <div className="space-y-2">
          <Label htmlFor="quick-password">{t("terminal.auth.passwordLabel")}</Label>
          <div className="relative">
            <Input
              id="quick-password"
              type={showPassword ? "text" : "password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={t("terminal.auth.password.placeholder")}
              className="pr-10"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter" && password.length > 0) {
                  handleConnect();
                }
              }}
            />
            <button
              type="button"
              className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              onClick={() => setShowPassword(!showPassword)}
            >
              {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
          </div>
        </div>
      )}

      {/* Key selection */}
      {authMethod === "key" && (
        <div className="space-y-2">
          {keys.filter((k) => k.category === "key").length === 0 ? (
            <div className="text-sm text-muted-foreground p-3 border border-dashed border-border/60 rounded-lg text-center">
              {t("terminal.auth.noKeysHint")}
            </div>
          ) : (
            <ScrollArea className="max-h-48">
              <div className="space-y-2">
                {keys
                  .filter((k) => k.category === "key")
                  .map((key) => (
                    <button
                      key={key.id}
                      className={cn(
                        "w-full flex items-center gap-3 px-3 py-2.5 rounded-lg border transition-colors text-left",
                        selectedKeyId === key.id
                          ? "border-primary bg-primary/5"
                          : "border-border/50 hover:bg-secondary/50",
                      )}
                      onClick={() => setSelectedKeyId(key.id)}
                    >
                      <div
                        className={cn(
                          "h-8 w-8 rounded-lg flex items-center justify-center",
                          "bg-primary/20 text-primary",
                        )}
                      >
                        <Key size={14} />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium truncate">
                          {key.label}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          Type {key.type}
                        </div>
                      </div>
                    </button>
                  ))}
              </div>
            </ScrollArea>
          )}

          {onAddKey && (
            <Button
              variant="outline"
              size="sm"
              className="w-full mt-2"
              onClick={onAddKey}
            >
              <Plus size={14} className="mr-2" />
              Add key
            </Button>
          )}
        </div>
      )}
        </>
      )}
    </div>
  );

  // Get step title
  const getStepTitle = () => {
    switch (step) {
      case "protocol":
        return target.hostname;
      case "username":
        return target.hostname;
      case "knownhost":
        return target.hostname;
      case "auth":
        return target.hostname;
    }
  };

  // Get step subtitle
  const getStepSubtitle = () => {
    const effectiveUsername = username || target.username || "";
    switch (step) {
      case "protocol":
        return target.hostname;
      case "username":
        return `${protocol.toUpperCase()} ${formatHostPort(target.hostname, port)}`;
      case "knownhost":
        return `${protocol.toUpperCase()} ${effectiveUsername}@${formatHostPort(target.hostname, port)}`;
      case "auth":
        return `${protocol.toUpperCase()} ${formatHostPort(target.hostname, port)}`;
    }
  };

  // Render progress indicator
  const renderProgressIndicator = () => {
    const steps: WizardStep[] = target.username
      ? ["protocol", "auth"]
      : ["protocol", "username", "auth"];
    const currentIndex = steps.indexOf(step);

    return (
      <div className="flex items-center gap-3 py-3">
        <div
          className={cn(
            "h-8 w-8 rounded-full flex items-center justify-center flex-shrink-0",
            currentIndex >= 0
              ? "bg-primary/20 text-primary"
              : "bg-muted text-muted-foreground",
          )}
        >
          <TerminalIcon size={14} />
        </div>
        <div className="flex-1 h-0.5 bg-muted" />
        {!target.username && (
          <>
            <div
              className={cn(
                "h-8 w-8 rounded-full flex items-center justify-center flex-shrink-0",
                currentIndex >= 1
                  ? "bg-primary/20 text-primary"
                  : "bg-muted text-muted-foreground",
              )}
            >
              <User size={14} />
            </div>
            <div className="flex-1 h-0.5 bg-muted" />
          </>
        )}
        <div
          className={cn(
            "h-8 w-8 rounded-full flex items-center justify-center flex-shrink-0",
            step === "auth"
              ? "bg-primary/20 text-primary"
              : "bg-muted text-muted-foreground",
          )}
        >
          {authMethod === "password" ? <Lock size={14} /> : <Key size={14} />}
        </div>
        <div className="flex-1 h-0.5 bg-muted" />
        <div className="h-8 w-8 rounded-full bg-muted text-muted-foreground flex items-center justify-center text-xs font-mono">
          {">_"}
        </div>
      </div>
    );
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      onClick={onClose}
    >
      <div
        className="w-[560px] max-w-[90vw] bg-background border border-border rounded-2xl animate-in fade-in-0 zoom-in-95 duration-200"
        style={{
          boxShadow:
            "0 25px 50px -12px rgba(0, 0, 0, 0.25), 0 12px 24px -8px rgba(0, 0, 0, 0.15)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-6 py-5 border-b border-border/50">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="h-12 w-12 rounded-xl bg-primary/15 text-primary flex items-center justify-center">
                <TerminalIcon size={22} />
              </div>
              <div>
                <h2 className="text-base font-semibold">{getStepTitle()}</h2>
                <p className="text-xs text-muted-foreground font-mono">
                  {getStepSubtitle()}
                </p>
              </div>
            </div>
          </div>
        </div>

        {/* Progress indicator */}
        <div className="px-6">{renderProgressIndicator()}</div>

        {warnings && warnings.length > 0 && (
          <div className="px-6 pb-2">
            <div className="text-xs text-amber-600 bg-amber-500/10 border border-amber-500/30 rounded-lg px-3 py-2">
              {t("quickConnect.warning.unparsedOptions", {
                options: warnings.join(", "),
              })}
            </div>
          </div>
        )}

        {/* Content */}
        <div className="px-6 py-4">
          {step === "protocol" && renderProtocolStep()}
          {step === "username" && renderUsernameStep()}
          {step === "knownhost" && renderKnownHostStep()}
          {step === "auth" && renderAuthStep()}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-border/50 flex items-center justify-between">
          <Button
            variant="secondary"
            onClick={step === "protocol" ? onClose : handleBack}
          >
            {step === "protocol" ? (
              t("common.close")
            ) : (
              <>
                <ArrowLeft size={14} className="mr-2" />
                {t("common.back")}
              </>
            )}
          </Button>

          {step === "knownhost" ? (
            <div className="flex items-center gap-2">
              <Button variant="secondary" onClick={handleContinue}>
                {t("common.continue")}
              </Button>
              <Button
                onClick={() => {
                  // Add to known hosts then continue
                  handleContinue();
                }}
              >
                {t("quickConnect.knownHost.addAndContinue")}
              </Button>
            </div>
          ) : step === "auth" ? (
            <div className="flex items-center gap-2">
              {onAddKey &&
                authMethod === "key" &&
                keys.filter((k) => k.category === "key").length === 0 && (
                  <Button variant="secondary" onClick={onAddKey}>
                    {t("quickConnect.addKey")}
                  </Button>
                )}
              <Dropdown open={saveOptionsOpen} onOpenChange={setSaveOptionsOpen}>
                <div className="flex items-center rounded-md bg-primary text-primary-foreground">
                  <Button
                    disabled={!canProceed}
                    onClick={() => handleConnect(false)}
                    className="rounded-r-none bg-transparent hover:bg-white/10 shadow-none"
                  >
                    {t("common.continue")}
                  </Button>
                  <DropdownTrigger asChild>
                    <Button
                      disabled={!canProceed}
                      aria-label={t("terminal.auth.continueSave")}
                      aria-haspopup="menu"
                      aria-expanded={saveOptionsOpen}
                      className="px-2 rounded-l-none bg-transparent hover:bg-white/10 border-l border-primary-foreground/20 shadow-none"
                    >
                      <ChevronDown size={14} />
                    </Button>
                  </DropdownTrigger>
                </div>
                <DropdownContent className="w-44 p-1" align="end" side="top">
                  <button
                    className="w-full px-3 py-2 text-sm text-left hover:bg-secondary rounded-md"
                    onClick={() => handleConnect(true)}
                    disabled={!canProceed}
                  >
                    {t("terminal.auth.continueSave")}
                  </button>
                </DropdownContent>
              </Dropdown>
            </div>
          ) : (
            <Button onClick={handleContinue} disabled={!canProceed}>
              {t("common.continue")}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
};

export default QuickConnectWizard;
