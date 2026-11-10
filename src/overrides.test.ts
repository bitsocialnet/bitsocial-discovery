import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { config } from './config.js';
import {
  overrideFor,
  parseOverrides,
  pollOverrides,
  setOverrides,
  startOverrides,
  stopOverrides,
} from './overrides.js';

test('parseOverrides keeps valid entries and skips the rest', () => {
  const parsed = parseOverrides([
    { address: 'A.bso', status: 'approved', nsfw: false },
    { address: 'b.bso', status: 'nonsense' },
    { status: 'hidden' },
    'c.bso',
    { address: 'd.bso', reason: 'note' },
  ]);
  assert.deepEqual([...parsed.keys()], ['a.bso', 'd.bso']);
  assert.deepEqual(parsed.get('a.bso'), { status: 'approved', nsfw: false });
  assert.throws(() => parseOverrides({}), /array/);
});

test('overrideFor merges aliases: strictest status, NSFW if any alias says so', () => {
  setOverrides(
    parseOverrides([
      { address: 'name.bso', status: 'approved', nsfw: false },
      { address: 'key', status: 'hidden', nsfw: true, reason: 'spam' },
    ]),
  );
  assert.deepEqual(overrideFor(['name.bso', 'key']), { status: 'hidden', nsfw: true, reason: 'spam' });
  assert.deepEqual(overrideFor(['NAME.bso']), { status: 'approved', nsfw: false });
  assert.deepEqual(overrideFor(['other.bso']), {});
  setOverrides(new Map());
});

test('overrideFor takes only restrictions from a name a record claims without proof', () => {
  setOverrides(
    parseOverrides([
      { address: 'approved.bso', status: 'approved', nsfw: false },
      { address: 'listed.bso', status: 'listed', nsfw: true },
      { address: 'hidden.bso', status: 'hidden', reason: 'spam' },
      { address: 'blocked.bso', status: 'blocked' },
      { address: 'key', status: 'listed', nsfw: false },
    ]),
  );
  assert.deepEqual(overrideFor(['key'], ['approved.bso']), { status: 'listed', nsfw: false });
  assert.deepEqual(overrideFor(['key'], ['listed.bso']), { status: 'listed', nsfw: true });
  assert.deepEqual(overrideFor(['key'], ['hidden.bso']), { status: 'hidden', nsfw: false, reason: 'spam' });
  assert.deepEqual(overrideFor([], ['blocked.bso']), { status: 'blocked' });
  assert.deepEqual(overrideFor([], ['approved.bso']), {});
  setOverrides(new Map());
});

test('pollOverrides applies the file, reloads it on change and clears it when deleted', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'discovery-overrides-'));
  const file = join(dir, 'overrides.json');
  try {
    await writeFile(file, JSON.stringify([{ address: 'x.bso', status: 'blocked' }]));
    await pollOverrides(file);
    assert.equal(overrideFor(['x.bso']).status, 'blocked');

    await writeFile(file, JSON.stringify([{ address: 'x.bso', status: 'approved' }]));
    const later = new Date(Date.now() + 5_000);
    await utimes(file, later, later);
    await pollOverrides(file);
    assert.equal(overrideFor(['x.bso']).status, 'approved');

    await writeFile(file, 'not json');
    const later2 = new Date(Date.now() + 10_000);
    await utimes(file, later2, later2);
    await pollOverrides(file);
    assert.equal(overrideFor(['x.bso']).status, 'approved', 'a broken file keeps the previous verdicts');

    await rm(file);
    await pollOverrides(file);
    assert.deepEqual(overrideFor(['x.bso']), {});
  } finally {
    await rm(dir, { recursive: true, force: true });
    setOverrides(new Map());
  }
});

test('startOverrides refuses to start when the configured review file cannot be loaded', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'discovery-overrides-'));
  const file = join(dir, 'overrides.json');
  const mutableConfig = config as unknown as Record<string, unknown>;
  mutableConfig.overridesSource = file;
  try {
    await assert.rejects(startOverrides(), /could not be loaded/, 'a missing file');
    await writeFile(file, 'not json');
    await assert.rejects(startOverrides(), /could not be loaded/, 'a broken file');

    await writeFile(file, JSON.stringify([{ address: 'x.bso', status: 'blocked' }]));
    await startOverrides();
    assert.equal(overrideFor(['x.bso']).status, 'blocked');
  } finally {
    stopOverrides();
    mutableConfig.overridesSource = '';
    await rm(dir, { recursive: true, force: true });
    setOverrides(new Map());
  }
});

test(
  'pollOverrides keeps the verdicts while the file cannot be read and clears them only once it is gone',
  { skip: process.getuid?.() === 0 ? 'root reads files whatever their permissions' : false },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), 'discovery-overrides-'));
    const mount = join(dir, 'config');
    const file = join(mount, 'overrides.json');
    try {
      await mkdir(mount);
      await writeFile(file, JSON.stringify([{ address: 'x.bso', status: 'blocked' }]));
      await utimes(file, 3_000_000, 3_000_000);
      await pollOverrides(file);
      assert.equal(overrideFor(['x.bso']).status, 'blocked');

      await chmod(mount, 0o000);
      await pollOverrides(file);
      assert.equal(overrideFor(['x.bso']).status, 'blocked', 'an unreadable file keeps the previous verdicts');

      await chmod(mount, 0o700);
      await rm(file);
      await pollOverrides(file);
      assert.deepEqual(overrideFor(['x.bso']), {});
    } finally {
      await chmod(mount, 0o700).catch(() => {});
      await rm(dir, { recursive: true, force: true });
      setOverrides(new Map());
    }
  },
);
