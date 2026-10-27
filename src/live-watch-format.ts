import { DebugProtocol } from '@vscode/debugprotocol';

export const LIVE_WATCH_FORMATS = ['natural', 'hexadecimal', 'decimal', 'binary', 'octal'] as const;
export type LiveWatchFormat = typeof LIVE_WATCH_FORMATS[number];

export function isLiveWatchFormat(value: unknown): value is LiveWatchFormat {
    return LIVE_WATCH_FORMATS.some((format) => format === value);
}

export interface LiveWatchEvaluateArguments extends DebugProtocol.EvaluateArguments {
    liveWatchFormat?: LiveWatchFormat;
}

export interface LiveWatchVariablesArguments extends DebugProtocol.VariablesArguments {
    liveWatchFormats?: Record<string, LiveWatchFormat>;
}
