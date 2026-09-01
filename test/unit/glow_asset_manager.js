const {test} = require('tap');
const JSZip = require('@turbowarp/jszip');
const Runtime = require('../../src/engine/runtime');
const GlowAssetManager = require('../../src/engine/glow-asset-manager');
const makeTestStorage = require('../fixtures/make-test-storage');

const makeRuntime = () => {
    const runtime = new Runtime();
    runtime.attachStorage(makeTestStorage());
    return runtime;
};

const bytes = (...values) => new Uint8Array(values);

/**
 * @param {object} asset an asset produced by the manager
 * @returns {string} the name it would have inside the project zip
 */
const md5extOf = asset => `${asset.assetId}.${asset.dataFormat}`;

test('set, get, has and list', t => {
    const manager = makeRuntime().glowAssetManager;

    t.equal(manager.get('glowML', 'training'), null, 'get before set');
    t.notOk(manager.has('glowML', 'training'), 'has before set');
    t.same(manager.list(), [], 'list before set');
    t.equal(manager.serializeJSON(), null, 'serializeJSON is null when empty');

    const asset = manager.set('glowML', 'training', 'json', bytes(1, 2, 3));
    t.equal(asset.dataFormat, 'json', 'dataFormat is kept');
    t.same(asset.data, bytes(1, 2, 3), 'data is kept');
    t.ok(asset.assetId, 'an id was generated from the content');

    t.equal(manager.get('glowML', 'training'), asset, 'get returns the asset');
    t.ok(manager.has('glowML', 'training'), 'has after set');
    t.same(manager.list(), [
        {ownerId: 'glowML', name: 'training', dataFormat: 'json', byteLength: 3}
    ], 'list describes it');
    t.end();
});

test('the same content always gets the same id', t => {
    const manager = makeRuntime().glowAssetManager;
    const first = manager.set('a', 'one', 'json', bytes(9, 9, 9));
    const second = manager.set('b', 'two', 'json', bytes(9, 9, 9));
    // This is what lets restore points store one copy and share it.
    t.equal(first.assetId, second.assetId, 'identical bytes hash the same');
    t.end();
});

test('owners and names do not collide', t => {
    const manager = makeRuntime().glowAssetManager;
    manager.set('ownerA', 'one', 'json', bytes(1));
    manager.set('ownerA', 'two', 'json', bytes(2, 2));
    manager.set('ownerB', 'one', 'json', bytes(3, 3, 3));

    t.same(manager.get('ownerA', 'one').data, bytes(1), 'ownerA/one');
    t.same(manager.get('ownerA', 'two').data, bytes(2, 2), 'ownerA/two');
    t.same(manager.get('ownerB', 'one').data, bytes(3, 3, 3), 'ownerB/one');

    t.equal(manager.list('ownerA').length, 2, 'list filters by owner');
    t.equal(manager.getBytesByOwner('ownerA'), 3, 'bytes by owner');
    t.equal(manager.getBytesByOwner('ownerB'), 3, 'bytes by the other owner');
    t.equal(manager.getTotalBytes(), 6, 'total bytes');
    t.end();
});

test('re-setting a key replaces it without double counting', t => {
    const manager = makeRuntime().glowAssetManager;
    manager.set('glowML', 'training', 'json', bytes(1, 2, 3, 4));
    t.equal(manager.getTotalBytes(), 4, 'first write');

    manager.set('glowML', 'training', 'json', bytes(5));
    t.equal(manager.getTotalBytes(), 1, 'second write replaced the first');
    t.equal(manager.list().length, 1, 'still one entry');
    t.same(manager.get('glowML', 'training').data, bytes(5), 'new content');
    t.end();
});

test('delete, deleteOwner and clear', t => {
    const manager = makeRuntime().glowAssetManager;
    manager.set('ownerA', 'one', 'json', bytes(1));
    manager.set('ownerA', 'two', 'json', bytes(2));
    manager.set('ownerB', 'one', 'json', bytes(3));

    t.notOk(manager.delete('ownerA', 'nope'), 'deleting something absent');
    t.ok(manager.delete('ownerA', 'one'), 'deleting something present');
    t.equal(manager.list().length, 2, 'one gone');

    t.equal(manager.deleteOwner('ownerA'), 1, 'deleteOwner reports how many');
    t.equal(manager.deleteOwner('ownerA'), 0, 'deleteOwner again removes nothing');
    t.equal(manager.list().length, 1, 'only ownerB is left');

    manager.clear();
    t.same(manager.list(), [], 'clear empties it');
    t.equal(manager.getTotalBytes(), 0, 'and the byte count');
    t.end();
});

test('set rejects bad input', t => {
    const manager = makeRuntime().glowAssetManager;
    const data = bytes(1);

    t.throws(() => manager.set('', 'name', 'json', data), 'empty owner');
    t.throws(() => manager.set('a/b', 'name', 'json', data), 'owner containing a slash');
    t.throws(() => manager.set('a'.repeat(65), 'name', 'json', data), 'owner too long');
    t.throws(() => manager.set(null, 'name', 'json', data), 'owner not a string');
    t.throws(() => manager.set('owner', '', 'json', data), 'empty name');
    t.throws(() => manager.set('owner', 'a b', 'json', data), 'name containing a space');
    t.throws(() => manager.set('owner', 'name', 'exe', data), 'format not on the whitelist');
    t.throws(() => manager.set('owner', 'name', 'JSON', data), 'format whitelist is case sensitive');
    t.throws(() => manager.set('owner', 'name', 'json', 'not bytes'), 'data not a Uint8Array');
    t.throws(() => manager.set('owner', 'name', 'json', [1, 2, 3]), 'data an ordinary array');

    t.same(manager.list(), [], 'nothing was stored by any of those');
    t.end();
});

test('names that would reach Object.prototype are stored as ordinary keys', t => {
    const manager = makeRuntime().glowAssetManager;
    // '__proto__' passes the name regex, so the defence is the Map, not the regex.
    manager.set('__proto__', 'constructor', 'json', bytes(7));
    t.same(manager.get('__proto__', 'constructor').data, bytes(7), 'stored as an ordinary key');
    t.equal(manager.get('anything', 'else'), null, 'nothing leaked onto other keys');
    t.equal({}.constructor, Object, 'Object.prototype is untouched');
    t.end();
});

test('the hard limit refuses a write and stores nothing', t => {
    const manager = makeRuntime().glowAssetManager;
    manager.maxBytes = 10;

    manager.set('owner', 'small', 'json', bytes(1, 2, 3, 4, 5));
    t.equal(manager.getTotalBytes(), 5, 'under the limit');

    t.throws(
        () => manager.set('owner', 'big', 'json', new Uint8Array(6)),
        'a write that would exceed the limit throws'
    );
    t.equal(manager.getTotalBytes(), 5, 'and stored nothing');
    t.notOk(manager.has('owner', 'big'), 'the refused entry is absent');

    // Replacing counts the old size as freed, so this fits where a new key would not.
    manager.set('owner', 'small', 'json', new Uint8Array(10));
    t.equal(manager.getTotalBytes(), 10, 'a replacement may use the whole budget');
    t.end();
});

test('the warning threshold fires once per crossing', t => {
    const manager = makeRuntime().glowAssetManager;
    manager.maxBytes = 100;
    manager.warnBytes = 10;

    const warnings = [];
    manager.on('warning', event => warnings.push(event));

    manager.set('owner', 'a', 'json', new Uint8Array(5));
    t.equal(warnings.length, 0, 'under the threshold, no warning');

    manager.set('owner', 'b', 'json', new Uint8Array(20));
    t.equal(warnings.length, 1, 'crossing it warns');
    t.equal(warnings[0].totalBytes, 25, 'the warning carries the total');
    t.equal(warnings[0].warnBytes, 10, 'and the threshold');
    t.equal(warnings[0].maxBytes, 100, 'and the ceiling');

    manager.set('owner', 'c', 'json', new Uint8Array(5));
    t.equal(warnings.length, 1, 'staying over it does not warn again');

    manager.delete('owner', 'b');
    manager.delete('owner', 'c');
    t.equal(warnings.length, 1, 'dropping below does not warn');

    manager.set('owner', 'd', 'json', new Uint8Array(20));
    t.equal(warnings.length, 2, 'crossing it again warns again');
    t.end();
});

test('change fires on writes and not on reads', t => {
    const manager = makeRuntime().glowAssetManager;
    let changes = 0;
    manager.on('change', () => changes++);

    manager.set('owner', 'one', 'json', bytes(1));
    t.equal(changes, 1, 'set');

    manager.get('owner', 'one');
    manager.has('owner', 'one');
    manager.list();
    manager.getTotalBytes();
    t.equal(changes, 1, 'reads do not');

    manager.delete('owner', 'nope');
    t.equal(changes, 1, 'a delete that removed nothing does not');

    manager.delete('owner', 'one');
    t.equal(changes, 2, 'a delete that removed something does');

    manager.clear();
    t.equal(changes, 3, 'clear');
    t.end();
});

test('serializeJSON and serializeAssets', t => {
    const manager = makeRuntime().glowAssetManager;
    const asset = manager.set('glowML', 'training', 'json', bytes(1, 2, 3));

    t.same(manager.serializeJSON(), [
        {owner: 'glowML', name: 'training', md5ext: md5extOf(asset)}
    ], 'the manifest names the file in the zip');
    t.same(manager.serializeAssets(), [asset], 'the assets themselves');

    manager.clear();
    t.equal(manager.serializeJSON(), null, 'null again once empty');
    t.same(manager.serializeAssets(), [], 'and no assets');
    t.end();
});

test('deserialize reads a manifest out of a zip', t => {
    const runtime = makeRuntime();
    const manager = runtime.glowAssetManager;
    const source = makeRuntime().glowAssetManager;
    const asset = source.set('glowML', 'training', 'json', bytes(4, 5, 6));

    const zip = new JSZip();
    zip.file(md5extOf(asset), asset.data);

    let changed = false;
    manager.on('change', () => {
        changed = true;
    });

    manager.deserialize(source.serializeJSON(), zip, false).then(() => {
        t.ok(changed, 'it emits change');
        t.same(manager.get('glowML', 'training').data, bytes(4, 5, 6), 'the data came back');
        t.equal(manager.get('glowML', 'training').dataFormat, 'json', 'and the format');
        t.equal(manager.getTotalBytes(), 3, 'and the byte count');
        t.end();
    });
});

test('deserialize keeps or clears what is already there', t => {
    const runtime = makeRuntime();
    const manager = runtime.glowAssetManager;
    const source = makeRuntime().glowAssetManager;
    const asset = source.set('glowML', 'incoming', 'json', bytes(1));

    const zip = new JSZip();
    zip.file(md5extOf(asset), asset.data);
    const manifest = source.serializeJSON();

    manager.set('other', 'existing', 'json', bytes(2));

    manager.deserialize(manifest, zip, true)
        .then(() => {
            t.ok(manager.has('other', 'existing'), 'keepExisting keeps the old one');
            t.ok(manager.has('glowML', 'incoming'), 'and adds the new one');
            return manager.deserialize(manifest, zip, false);
        })
        .then(() => {
            t.notOk(manager.has('other', 'existing'), 'without keepExisting the old one goes');
            t.ok(manager.has('glowML', 'incoming'), 'and the new one is there');
            t.end();
        });
});

test('deserialize survives hostile input', t => {
    const runtime = makeRuntime();
    const manager = runtime.glowAssetManager;
    // The entry that is missing from the zip falls through to storage.load(); fail it
    // here so the test never reaches the network.
    runtime.storage.load = () => Promise.reject(new Error('not available offline'));

    const source = makeRuntime().glowAssetManager;
    const good = source.set('glowML', 'good', 'json', bytes(1, 2));
    const zip = new JSZip();
    zip.file(md5extOf(good), good.data);

    const manifest = [
        null,
        'a string',
        42,
        {},
        {owner: 'glowML', name: 'noMd5ext'},
        {owner: 'glowML', name: 'badMd5ext', md5ext: 42},
        {owner: '', name: 'emptyOwner', md5ext: md5extOf(good)},
        {owner: 'glow/Ml', name: 'slashOwner', md5ext: md5extOf(good)},
        {owner: 'glowML', name: 'bad name', md5ext: md5extOf(good)},
        {owner: 'glowML', name: 'notWhitelisted', md5ext: '00000000000000000000000000000000.exe'},
        {owner: 'glowML', name: 'missingFromZip', md5ext: '00000000000000000000000000000000.json'},
        // The one good entry, last, to prove the bad ones did not stop the loop.
        {owner: 'glowML', name: 'good', md5ext: md5extOf(good)}
    ];

    manager.deserialize(manifest, zip, false).then(() => {
        t.same(manager.list(), [
            {ownerId: 'glowML', name: 'good', dataFormat: 'json', byteLength: 2}
        ], 'only the valid entry was kept');
        t.end();
    });
});

test('deserialize copes with storage resolving null', t => {
    const runtime = makeRuntime();
    const manager = runtime.glowAssetManager;
    // Nothing is registered for our asset type, so a real ScratchStorage resolves null
    // here rather than rejecting. That is the path a project takes when its asset file
    // is genuinely absent from the zip.
    runtime.storage.load = () => Promise.resolve(null);

    manager.deserialize([
        {owner: 'glowML', name: 'missing', md5ext: '00000000000000000000000000000000.json'}
    ], null, false).then(() => {
        t.same(manager.list(), [], 'the entry was dropped, not stored as null');
        t.end();
    });
});

test('deserialize accepts things that are not manifests at all', t => {
    const manager = makeRuntime().glowAssetManager;
    manager.set('owner', 'existing', 'json', bytes(1));

    Promise.all([
        manager.deserialize(undefined, null, true),
        manager.deserialize(null, null, true),
        manager.deserialize('nonsense', null, true),
        manager.deserialize({not: 'an array'}, null, true),
        manager.deserialize(7, null, true)
    ]).then(() => {
        t.ok(manager.has('owner', 'existing'), 'none of them threw or lost data');
        t.end();
    });
});

test('deserialize stops at the byte limit', t => {
    const runtime = makeRuntime();
    const manager = runtime.glowAssetManager;
    manager.maxBytes = 6;

    const source = makeRuntime().glowAssetManager;
    const first = source.set('owner', 'first', 'json', new Uint8Array([1, 2, 3, 4]));
    const second = source.set('owner', 'second', 'json', new Uint8Array([5, 6, 7, 8]));

    const zip = new JSZip();
    zip.file(md5extOf(first), first.data);
    zip.file(md5extOf(second), second.data);

    manager.deserialize(source.serializeJSON(), zip, false).then(() => {
        t.equal(manager.list().length, 1, 'the second entry did not fit');
        t.equal(manager.getTotalBytes(), 4, 'and the total respects the ceiling');
        t.end();
    });
});

test('formatBytes reads like a size, not a number', t => {
    const f = GlowAssetManager.formatBytes;
    t.equal(f(0), '0 bytes', 'zero');
    t.equal(f(3), '3 bytes', 'a few bytes');
    t.equal(f(1023), '1023 bytes', 'just under a kilobyte');
    t.equal(f(1024), '1 KB', 'exactly a kilobyte, with no pointless .0');
    t.equal(f(1536), '1.5 KB', 'one decimal place');
    t.equal(f(8388608), '8 MB', 'the default ceiling');
    t.equal(f(11155908), '10.6 MB', 'the number from a real overflow');
    t.equal(f(2 * 1024 * 1024 * 1024), '2 GB', 'gigabytes');
    t.end();
});

test('the limit error carries the numbers as well as the message', t => {
    const manager = makeRuntime().glowAssetManager;
    manager.maxBytes = 10;
    manager.set('owner', 'a', 'json', new Uint8Array(8));

    let thrown = null;
    try {
        manager.set('owner', 'b', 'json', new Uint8Array(8));
    } catch (error) {
        thrown = error;
    }
    t.ok(thrown, 'it threw');
    t.equal(thrown.totalBytes, 16, 'the size it would have been');
    t.equal(thrown.maxBytes, 10, 'and the ceiling');
    t.match(thrown.message, '16 bytes', 'the message is readable, not raw');
    t.end();
});

test('static helpers', t => {
    t.same(GlowAssetManager.ALLOWED_FORMATS, ['json'], 'json only, for now');
    t.ok(GlowAssetManager.isAllowedFormat('json'), 'json is allowed');
    t.notOk(GlowAssetManager.isAllowedFormat('exe'), 'exe is not');
    t.notOk(GlowAssetManager.isAllowedFormat(null), 'nor is a non-string');
    t.ok(GlowAssetManager.isValidName('glow-ml.thing_1'), 'word characters, dot and dash');
    t.notOk(GlowAssetManager.isValidName('has space'), 'no spaces');
    t.notOk(GlowAssetManager.isValidName(''), 'not empty');
    t.notOk(GlowAssetManager.isValidName(undefined), 'not undefined');
    t.equal(typeof GlowAssetManager.DEFAULT_MAX_BYTES, 'number', 'the default ceiling is exposed');
    t.ok(GlowAssetManager.DEFAULT_WARN_BYTES < GlowAssetManager.DEFAULT_MAX_BYTES, 'warn below max');
    t.end();
});

test('deserialize refuses an md5ext that is not a hash and one extension', t => {
    const manager = makeRuntime().glowAssetManager;
    // Nothing here should reach the network; fail storage.load() so a slip is loud.
    manager.runtime.storage.load = () => Promise.reject(new Error('must not be reached'));

    const source = makeRuntime().glowAssetManager;
    const good = source.set('glowML', 'training', 'json', bytes(1, 2, 3));

    const zip = new JSZip();
    zip.file(md5extOf(good), good.data);
    // Every hostile name below is also present in the zip, so only the check in
    // deserialize can be what keeps it out.
    const hostile = [
        // Two dots: deserialize reads the format from the last, AssetUtil from the
        // first, so this used to be stored with dataFormat 'exe'.
        [`${good.assetId}.exe.json`, 'two extensions'],
        // No dot at all: passes a naive format check, then throws inside AssetUtil.
        ['json', 'no extension'],
        // A path: assetId is written straight back out as a zip member name on save.
        ['dir/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.json', 'a path'],
        ['../aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.json', 'a parent walk'],
        // Interpolated into a RegExp and run over every file in the zip.
        ['(x+x+)+y.json', 'a regular expression'],
        ['abc.json', 'too short to be a hash'],
        [`${good.assetId.toUpperCase()}.json`, 'uppercase hex'],
        [`${good.assetId}.JSON`, 'uppercase extension'],
        [`${good.assetId}.exe`, 'a format that is not whitelisted']
    ];
    for (const [md5ext] of hostile) {
        zip.file(md5ext, bytes(9, 9, 9));
    }

    const manifest = hostile.map(([md5ext], i) => ({owner: 'attacker', name: `a${i}`, md5ext}));
    // A valid entry alongside them, to prove one bad entry does not stop the load.
    manifest.push({owner: 'glowML', name: 'training', md5ext: md5extOf(good)});

    manager.deserialize(manifest, zip, false).then(() => {
        hostile.forEach(([, what], i) => {
            t.notOk(manager.has('attacker', `a${i}`), `${what} is refused`);
        });
        t.ok(manager.has('glowML', 'training'), 'the valid entry beside them still loads');
        t.same(
            manager.list().map(entry => entry.dataFormat),
            ['json'],
            'and everything admitted really is json'
        );
        t.equal({}.polluted, undefined, 'Object.prototype is untouched');
        t.end();
    });
});

test('deserialize takes the first of two entries with the same key', t => {
    const manager = makeRuntime().glowAssetManager;
    const source = makeRuntime().glowAssetManager;
    const first = source.set('glowML', 'training', 'json', bytes(1));
    const second = makeRuntime().glowAssetManager.set('glowML', 'training', 'json', bytes(2, 2));

    const zip = new JSZip();
    zip.file(md5extOf(first), first.data);
    zip.file(md5extOf(second), second.data);

    const manifest = [
        {owner: 'glowML', name: 'training', md5ext: md5extOf(first)},
        {owner: 'glowML', name: 'training', md5ext: md5extOf(second)}
    ];

    manager.deserialize(manifest, zip, false).then(() => {
        t.equal(manager.list().length, 1, 'only one entry for the key');
        t.same(manager.get('glowML', 'training').data, bytes(1), 'the first one won');
        t.end();
    });
});

test('deserialize stops at the byte limit rather than skipping past it', t => {
    const manager = makeRuntime().glowAssetManager;
    manager.maxBytes = 6;

    const source = makeRuntime().glowAssetManager;
    const first = source.set('owner', 'first', 'json', new Uint8Array(4));
    const tooBig = source.set('owner', 'second', 'json', new Uint8Array(8));
    // Small enough to fit after the one that did not. Admitting it would make what
    // survives depend on the order the entries happen to be written in.
    const small = source.set('owner', 'third', 'json', new Uint8Array(1));

    const zip = new JSZip();
    [first, tooBig, small].forEach(asset => zip.file(md5extOf(asset), asset.data));

    manager.deserialize(source.serializeJSON(), zip, false).then(() => {
        t.ok(manager.has('owner', 'first'), 'what fitted was kept');
        t.notOk(manager.has('owner', 'second'), 'what did not fit was refused');
        t.notOk(manager.has('owner', 'third'), 'and it stopped rather than carrying on');
        t.equal(manager.getTotalBytes(), 4, 'the total respects the ceiling');
        t.end();
    });
});

test('deserialize refuses a manifest with absurdly many entries', t => {
    const manager = makeRuntime().glowAssetManager;
    manager.runtime.storage.load = () => Promise.reject(new Error('must not be reached'));

    const source = makeRuntime().glowAssetManager;
    const asset = source.set('glowML', 'training', 'json', bytes(1));
    const zip = new JSZip();
    zip.file(md5extOf(asset), asset.data);

    const manifest = [];
    for (let i = 0; i < 5000; i++) {
        manifest.push({owner: 'glowML', name: `a${i}`, md5ext: md5extOf(asset)});
    }

    manager.deserialize(manifest, zip, false).then(() => {
        t.same(manager.list(), [], 'none of them loaded');
        t.end();
    });
});
