import assert from 'node:assert/strict';

// Copy to <feature>.scenario.mjs and replace AC IDs/assertions with actual requirements.
export default {
  id: 'fixture-smoke',
  acceptanceCriteria: ['AC-REPLACE'],
  visual: false,
  async setup({ mct }) {
    await mct(['chat', 'command', 'time set 6000']);
    await mct(['chat', 'command', 'weather clear']);
    await mct(['chat', 'command', 'gamerule doDaylightCycle false']);
    await mct(['chat', 'command', 'gamerule doWeatherCycle false']);
  },
  async actions({ mct }) { await mct(['gui', 'close']); },
  async assertions({ mct }) {
    const position = await mct(['position', 'get']);
    assert.ok(Number.isFinite(position.x), 'Player position must be available in-world');
  },
  screenshots: [],
  async cleanup({ mct }) { await mct(['gui', 'close']); }
};
