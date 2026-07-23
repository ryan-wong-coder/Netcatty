import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { AuthenticationChallenge } from '@netcatty/plugin-contract';
import { ExternalLink } from 'lucide-react';
import { useI18n } from '../../application/i18n/I18nProvider';
import { pluginExtensionBridge } from '../../application/state/pluginExtensionBridge';
import { isSafePluginAuthenticationUrl } from '../../domain/pluginConnection';
import { Button } from '../ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';
import { Input } from '../ui/input';
import { Label } from '../ui/label';

type ChallengeEvent = NetcattyPluginAuthenticationChallengeEvent;
type ChallengeResponse = string | boolean | ReadonlyArray<string>;

const challengeMessage = (challenge: AuthenticationChallenge): string | undefined => (
  'message' in challenge && typeof challenge.message === 'string' ? challenge.message : undefined
);

export const PluginAuthenticationHost: React.FC = () => {
  const { t } = useI18n();
  const [queue, setQueue] = useState<ChallengeEvent[]>([]);
  const [textValue, setTextValue] = useState('');
  const [selectedChoices, setSelectedChoices] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const current = queue[0];
  const challenge = current?.challenge;

  useEffect(() => {
    return pluginExtensionBridge.onAuthenticationChallenge((event) => {
      setQueue((existing) => {
        if (existing.some((item) => item.challengeRequestId === event.challengeRequestId)) return existing;
        if (existing.length >= 32) {
          void pluginExtensionBridge.respondAuthenticationChallenge({
            requestId: event.requestId,
            challengeRequestId: event.challengeRequestId,
            challengeId: event.challenge.id,
            cancelled: true,
          }).catch(() => {});
          return existing;
        }
        return [...existing, event].slice(0, 32);
      });
    });
  }, []);

  useEffect(() => {
    setTextValue('');
    setSelectedChoices([]);
    setBusy(false);
  }, [current?.challengeRequestId]);

  const complete = useCallback(async (response?: ChallengeResponse, cancelled = false) => {
    if (!current || busy) return;
    setBusy(true);
    try {
      await pluginExtensionBridge.respondAuthenticationChallenge({
        requestId: current.requestId,
        challengeRequestId: current.challengeRequestId,
        challengeId: current.challenge.id,
        ...(cancelled ? { cancelled: true } : { response }),
      });
      setQueue((existing) => existing.filter((item) => item.challengeRequestId !== current.challengeRequestId));
    } catch {
      setQueue((existing) => existing.filter((item) => item.challengeRequestId !== current.challengeRequestId));
    } finally {
      setBusy(false);
    }
  }, [busy, current]);

  const externalUrl = useMemo(() => {
    if (!challenge) return null;
    const value = challenge.kind === 'browser'
      ? challenge.url
      : challenge.kind === 'deviceCode'
        ? challenge.verificationUri
        : null;
    return value && isSafePluginAuthenticationUrl(value) ? value : null;
  }, [challenge]);

  const openExternal = useCallback(async () => {
    if (!externalUrl) return;
    await pluginExtensionBridge.openExternal(externalUrl);
  }, [externalUrl]);

  if (!challenge) return null;
  const message = challengeMessage(challenge);
  const isText = challenge.kind === 'text' || challenge.kind === 'password' || challenge.kind === 'otp';
  const canSubmit = challenge.kind === 'choice'
    ? selectedChoices.length > 0
    : isText
      ? textValue.length > 0
      : challenge.kind === 'browser' || challenge.kind === 'deviceCode'
        ? externalUrl !== null
        : true;

  const submit = () => {
    if (isText) void complete(textValue);
    else if (challenge.kind === 'choice') {
      void complete(challenge.multiple ? selectedChoices : selectedChoices[0]);
    } else {
      void complete(true);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open) void complete(undefined, true); }}>
      <DialogContent className="sm:max-w-[480px]" hideCloseButton>
        <DialogHeader>
          <DialogTitle>{challenge.title}</DialogTitle>
          <DialogDescription>
            {message || t('plugins.authentication.description')}
          </DialogDescription>
        </DialogHeader>

        {isText && (
          <div className="space-y-2">
            <Label htmlFor="plugin-authentication-value">
              {challenge.kind === 'otp'
                ? t('plugins.authentication.code')
                : challenge.kind === 'password'
                  ? t('plugins.authentication.password')
                  : t('plugins.authentication.value')}
            </Label>
            <Input
              id="plugin-authentication-value"
              type={challenge.kind === 'password' ? 'password' : 'text'}
              autoComplete={challenge.kind === 'password' ? 'current-password' : challenge.kind === 'otp' ? 'one-time-code' : 'off'}
              value={textValue}
              maxLength={8192}
              disabled={busy}
              onChange={(event) => setTextValue(event.target.value)}
              onKeyDown={(event) => { if (event.key === 'Enter' && canSubmit) submit(); }}
              autoFocus
            />
          </div>
        )}

        {challenge.kind === 'choice' && (
          <div className="max-h-64 space-y-2 overflow-y-auto">
            {challenge.choices.map((choice) => {
              const selected = selectedChoices.includes(choice.id);
              return (
                <label key={choice.id} className="flex cursor-pointer items-start gap-3 rounded-md border p-3">
                  <input
                    type={challenge.multiple ? 'checkbox' : 'radio'}
                    name="plugin-authentication-choice"
                    className="mt-0.5 h-4 w-4 accent-primary"
                    checked={selected}
                    disabled={busy}
                    onChange={(event) => {
                      const checked = event.target.checked;
                      setSelectedChoices((existing) => challenge.multiple
                        ? checked
                          ? [...new Set([...existing, choice.id])]
                          : existing.filter((id) => id !== choice.id)
                        : checked ? [choice.id] : []);
                    }}
                  />
                  <span className="space-y-1">
                    <span className="block text-sm font-medium">{choice.label}</span>
                    {choice.description && <span className="block text-xs text-muted-foreground">{choice.description}</span>}
                  </span>
                </label>
              );
            })}
          </div>
        )}

        {(challenge.kind === 'browser' || challenge.kind === 'deviceCode') && (
          <div className="space-y-3 rounded-md border p-3">
            {challenge.kind === 'deviceCode' && (
              <div>
                <div className="text-xs text-muted-foreground">{t('plugins.authentication.deviceCode')}</div>
                <code className="select-all text-base font-semibold">{challenge.userCode}</code>
              </div>
            )}
            {externalUrl ? (
              <Button type="button" variant="outline" className="w-full" onClick={() => void openExternal()}>
                <ExternalLink className="mr-2 h-4 w-4" />
                {t('plugins.authentication.openBrowser')}
              </Button>
            ) : (
              <p className="text-sm text-destructive">{t('plugins.authentication.invalidUrl')}</p>
            )}
          </div>
        )}

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() => void (challenge.kind === 'confirmation'
              ? complete(false)
              : complete(undefined, true))}
          >
            {challenge.kind === 'confirmation' && challenge.cancelLabel
              ? challenge.cancelLabel
              : t('common.cancel')}
          </Button>
          {challenge.kind === 'confirmation' ? (
            <Button type="button" disabled={busy} onClick={() => void complete(true)}>
              {challenge.confirmLabel || t('common.confirm')}
            </Button>
          ) : (
            <Button type="button" disabled={busy || !canSubmit} onClick={submit}>
              {challenge.kind === 'browser' || challenge.kind === 'deviceCode'
                ? t('plugins.authentication.continue')
                : t('common.confirm')}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
