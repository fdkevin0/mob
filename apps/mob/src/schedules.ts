// The schedules plugin: prompts the owner's model runs on its own later.
import { Schedules, schedulePlugin } from '@mob/core';
import { hostPlugins } from './local';

hostPlugins.push((_, server) => [schedulePlugin(new Schedules(server.options.store, server))]);
