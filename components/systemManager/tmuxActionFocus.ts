import type { TmuxManageAction } from '../../domain/systemManager/types';

type TmuxActionResult = {
  success: boolean;
  error?: string;
};

type TmuxActionPayload = { sessionId: string } & TmuxManageAction;

interface RunTmuxSessionActionOptions {
  sessionId: string;
  action: TmuxManageAction;
  tmuxAction: (payload: TmuxActionPayload) => Promise<TmuxActionResult>;
  onRefreshDetails?: () => Promise<void>;
  onSessionsChanged: () => Promise<void>;
  onRequestTerminalFocus?: () => void;
}

const shouldRequestTerminalFocusAfterAction = (action: TmuxManageAction): boolean =>
  action.action === 'detachSession';

export async function runTmuxSessionAction({
  sessionId,
  action,
  tmuxAction,
  onRefreshDetails,
  onSessionsChanged,
  onRequestTerminalFocus,
}: RunTmuxSessionActionOptions): Promise<TmuxActionResult> {
  const result = await tmuxAction({ sessionId, ...action });
  if (!result.success) return result;

  try {
    await onRefreshDetails?.();
    await onSessionsChanged();
  } finally {
    if (shouldRequestTerminalFocusAfterAction(action)) {
      onRequestTerminalFocus?.();
    }
  }

  return result;
}
