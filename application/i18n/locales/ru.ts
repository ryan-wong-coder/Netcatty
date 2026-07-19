import type { Messages } from './types';
import { ruCoreMessages } from './ru/core';
import { ruVaultMessages } from './ru/vault';
import { ruTerminalMessages } from './ru/terminal';
import { ruAiMessages } from './ru/ai';
import { ruSystemManagerMessages } from './ru/systemManager';
import { ruScriptsMessages } from './ru/scripts';

export type { Messages } from './types';

const ru: Messages = {
  ...ruCoreMessages,
  ...ruVaultMessages,
  ...ruTerminalMessages,
  ...ruAiMessages,
  ...ruSystemManagerMessages,
  ...ruScriptsMessages,
};

export default ru;
