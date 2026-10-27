export interface LiveWatchDebugger {
    start(cwd: string, commands: string[]): PromiseLike<void>;
    stop(disconnect: boolean): PromiseLike<void>;
    once?(event: string, listener: (...args: any[]) => void): unknown;
    removeListener?(event: string, listener: (...args: any[]) => void): unknown;
}

// Cleanup must not wait on a stalled MI queue. MI2.stop has its own forced-kill timer.
export async function startLiveWatchDebugger(
    debuggerApi: LiveWatchDebugger, cwd: string, commands: string[], timeoutMs = 15000): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    let rejectStartup: (error: Error) => void;
    const onQuit = () => rejectStartup(new Error('Live GDB exited before initialization completed'));
    const onLaunchError = (error: Error) => rejectStartup(error);
    try {
        await new Promise<void>((resolve, reject) => {
            rejectStartup = reject;
            debuggerApi.once?.('quit', onQuit);
            debuggerApi.once?.('launcherror', onLaunchError);
            timer = setTimeout(() => reject(new Error(`Live GDB initialization timed out after ${timeoutMs}ms`)), timeoutMs);
            Promise.resolve(debuggerApi.start(cwd, commands)).then(resolve, reject);
        });
    } catch (error) {
        try {
            Promise.resolve(debuggerApi.stop(true)).catch(() => { /* The original startup error is reported by the caller. */ });
        } catch (cleanupError) {
            // A partially spawned debugger can also fail synchronously during cleanup.
        }
        throw error;
    } finally {
        if (timer) { clearTimeout(timer); }
        debuggerApi.removeListener?.('quit', onQuit);
        debuggerApi.removeListener?.('launcherror', onLaunchError);
    }
}
