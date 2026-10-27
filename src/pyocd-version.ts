import { execFile } from 'child_process';

export interface PyOCDLiveWatchVersion {
    status: 'compatible' | 'old' | 'unknown';
    version?: string;
}

export function parsePyOCDLiveWatchVersion(output: string): PyOCDLiveWatchVersion {
    const match = /^(?:pyocd(?: version)?\s+)?(\d+)\.(\d+)\.(\d+)([a-z0-9.+-]*)$/i.exec(output.trim());
    if (!match) { return { status: 'unknown' }; }
    const version = `${match[1]}.${match[2]}.${match[3]}${match[4]}`;
    if (Number(match[1]) === 0 && Number(match[2]) < 45) { return { status: 'old', version }; }
    // Development builds can precede the multi-client implementation in a final release.
    return { status: /dev|rc|alpha|beta|[ab]\d/i.test(match[4]) ? 'unknown' : 'compatible', version };
}

export function checkPyOCDLiveWatchVersion(executable: string, cwd: string): Promise<PyOCDLiveWatchVersion> {
    return new Promise((resolve) => {
        execFile(executable, ['--version'], { cwd, timeout: 3000, windowsHide: true, maxBuffer: 64 * 1024 }, (error, stdout) => {
            resolve(error ? { status: 'unknown' } : parsePyOCDLiveWatchVersion(stdout));
        });
    });
}
