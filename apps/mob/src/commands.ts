// Commands that plugins of the host add to the command line, such as mob runner.
import type { Command } from 'commander';
import type { Environment } from './config';

export const commands: ((environment: () => Environment) => Command)[] = [];
