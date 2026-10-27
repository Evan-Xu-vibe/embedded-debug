import * as assert from 'assert';
import { liveWatchRefreshInterval } from '../../src/live-watch-utils';

suite('Live Watch Utils', () => {
    test('Clamps the sample rate to the supported range', () => {
        assert.equal(liveWatchRefreshInterval(4), 250);
        assert.equal(liveWatchRefreshInterval(0), 1000);
        assert.equal(liveWatchRefreshInterval(100), 200);
        assert.equal(liveWatchRefreshInterval(undefined), 250);
        assert.equal(liveWatchRefreshInterval(NaN), 250);
        assert.equal(liveWatchRefreshInterval(Infinity), 250);
        assert.equal(liveWatchRefreshInterval(20, 400), 400);
        assert.equal(liveWatchRefreshInterval(20, 100), 200);
        assert.equal(liveWatchRefreshInterval(20, NaN), 300);
    });
});
