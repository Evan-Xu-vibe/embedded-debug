import * as assert from 'assert';
import { GDBDebugSession } from '../../src/gdb';
import { MI2 } from '../../src/backend/mi2/mi2';
import { LiveWatchMonitor } from '../../src/live-watch-monitor';
import { TcpPortScanner } from '../../src/tcpportscanner';
import { PyOCDServerController } from '../../src/pyocd';
import { parsePyOCDLiveWatchVersion, checkPyOCDLiveWatchVersion } from '../../src/pyocd-version';
import { startLiveWatchDebugger } from '../../src/live-watch-startup';
import { EventEmitter } from 'events';

suite('pyOCD Live Watch compatibility', () => {
    test('Classifies released, old, development and unrecognized versions', () => {
        for (const output of ['0.45.0', 'pyOCD 0.45.1', 'pyocd version 0.46.0', '1.0.0']) {
            assert.equal(parsePyOCDLiveWatchVersion(output).status, 'compatible');
        }
        assert.deepEqual(parsePyOCDLiveWatchVersion('0.44.0'), { status: 'old', version: '0.44.0' });
        for (const output of ['0.45.0rc1', '0.45.0.dev0', 'unrecognized', 'v22.0.0']) {
            assert.equal(parsePyOCDLiveWatchVersion(output).status, 'unknown');
        }
    });

    test('A missing executable yields Unknown without aborting configuration resolution', async () => {
        const result = await checkPyOCDLiveWatchVersion('cortex-debug-test-missing-pyocd', process.cwd());
        assert.equal(result.status, 'unknown');
    });

    test('The real version probe rejects output from an unrelated executable', async () => {
        const result = await checkPyOCDLiveWatchVersion(process.execPath, process.cwd());
        assert.equal(result.status, 'unknown');
    });

    test('Connects Live GDB to the selected core without reset, programming or execution commands', () => {
        const controller = new PyOCDServerController();
        controller.setArguments({ targetProcessor: 1 } as any);
        controller.setPorts({ gdbPort: 50000, gdbPort1: 50001 });
        assert.deepEqual(controller.liveGdbInitCommands(), [
            'target-select extended-remote localhost:50001',
            'interpreter-exec console "set mem inaccessible-by-default off"'
        ]);
    });

    test('A successful startup does not close the debugger', async () => {
        let started = false;
        await startLiveWatchDebugger({
            start: (cwd, commands) => {
                assert.equal(cwd, 'workspace');
                assert.deepEqual(commands, ['connect']);
                started = true;
                return Promise.resolve();
            },
            stop: () => assert.fail('Successful startup was cleaned up')
        }, 'workspace', ['connect'], 100);
        assert.equal(started, true);
    });

    test('A stalled second connection times out even when cleanup also stalls', async () => {
        let stopped = 0;
        await assert.rejects(startLiveWatchDebugger({
            start: () => new Promise<void>(() => { }),
            stop: (disconnect) => {
                assert.equal(disconnect, true);
                stopped++;
                return new Promise<void>(() => { });
            }
        }, '.', [], 5), /timed out/);
        assert.equal(stopped, 1);
    });

    test('A failed startup closes the auxiliary debugger and preserves the original error', async () => {
        const failure = new Error('second connection refused');
        let stopped = false;
        await assert.rejects(startLiveWatchDebugger({
            start: () => Promise.reject(failure),
            stop: () => {
                stopped = true;
                return Promise.reject(new Error('cleanup failed'));
            }
        }, '.', []), (error) => error === failure);
        assert.equal(stopped, true);
    });

    for (const event of ['quit', 'launcherror']) {
        test(`An early ${event} fails promptly and removes startup listeners`, async () => {
            let stopped = false;
            const debuggerApi = Object.assign(new EventEmitter(), {
                start: () => {
                    queueMicrotask(() => debuggerApi.emit(event, new Error('spawn failed')));
                    return new Promise<void>(() => { });
                },
                stop: () => {
                    stopped = true;
                    return Promise.resolve();
                }
            });
            await assert.rejects(startLiveWatchDebugger(debuggerApi, '.', []), /spawn failed|exited before initialization/);
            assert.equal(stopped, true);
            assert.equal(debuggerApi.listenerCount('quit'), 0);
            assert.equal(debuggerApi.listenerCount('launcherror'), 0);
        });
    }
});

suite('Live GDB server-specific initialization', () => {
    // Preserve methods for prototype replacement; binding them would break restoration.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const originalStart = MI2.prototype.start;
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const originalStop = MI2.prototype.stop;
    let session: any;

    setup(() => {
        session = new GDBDebugSession(false);
        session.miDebugger = { application: 'gdb', args: [] };
        session.args = { cwd: '.' };
        session.gdbInitCommands = ['file-exec-and-symbols "firmware.elf"'];
        session.symInitCommands = ['interpreter-exec console "add-symbol-file extra.elf"'];
    });

    teardown(() => {
        MI2.prototype.start = originalStart;
        MI2.prototype.stop = originalStop;
        TcpPortScanner.PortAllocated.removeListener('allocated', session.tcpPortAllocatedListner);
    });

    test('Uses the Live hook and preserves symbols, without changing main-GDB initialization', async () => {
        session.serverController = {
            initCommands: () => ['main-connect'],
            liveGdbInitCommands: () => ['live-connect']
        };
        let actual: string[];
        MI2.prototype.start = function (_cwd, commands) {
            assert.equal(this.forLiveGdb, true);
            actual = commands;
            return Promise.resolve();
        };
        await session.startGdbForLiveWatch(new LiveWatchMonitor(session));
        assert.ok(actual.includes('live-connect'));
        assert.ok(!actual.includes('main-connect'));
        assert.ok(actual.includes('file-exec-and-symbols "firmware.elf"'));
        assert.ok(actual.includes('interpreter-exec console "add-symbol-file extra.elf"'));
        assert.ok(actual.includes('interpreter-exec console "set remote interrupt-on-connect off"'));
        assert.deepEqual(session.getServerConnectCommands(), ['main-connect', ...session.symInitCommands]);
    });

    test('Existing servers without a Live hook keep their normal connection commands', async () => {
        session.serverController = { initCommands: () => ['ordinary-connect'] };
        MI2.prototype.start = (_cwd, commands) => {
            assert.ok(commands.includes('ordinary-connect'));
            return Promise.resolve();
        };
        await session.startGdbForLiveWatch(new LiveWatchMonitor(session));
    });

    test('Startup failure stops only the auxiliary MI2 instance', async () => {
        session.serverController = { initCommands: () => ['connect'] };
        MI2.prototype.start = () => Promise.reject(new Error('connection refused'));
        let stopped = 0;
        MI2.prototype.stop = function () {
            assert.equal(this.forLiveGdb, true);
            stopped++;
            return Promise.resolve();
        };
        await assert.rejects(session.startGdbForLiveWatch(new LiveWatchMonitor(session)), /connection refused/);
        assert.equal(stopped, 1);
        assert.equal(session.miLiveGdb, undefined);
    });

    test('Auxiliary GDB forced cleanup terminates its process on every platform', () => {
        const debuggerApi: any = new MI2('gdb', [], true);
        let killed = false;
        debuggerApi.process = { pid: 123, kill: () => {
            killed = true;
        } };
        debuggerApi.tryKill();
        assert.equal(killed, true);
    });
});
