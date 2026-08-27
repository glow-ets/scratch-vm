const fs = require('fs');
const path = require('path');
const {test} = require('tap');
const JSZip = require('@turbowarp/jszip');
const VirtualMachine = require('../../src/virtual-machine');
const makeTestStorage = require('../fixtures/make-test-storage');

const emptyProjectFixture = path.join(__dirname, '..', 'fixtures', 'tw-empty-project.sb3');

const makeVM = () => {
    const vm = new VirtualMachine();
    vm.attachStorage(makeTestStorage());
    return vm;
};

const loadEmptyProject = vm => vm.loadProject(fs.readFileSync(emptyProjectFixture));

const md5extOf = asset => `${asset.assetId}.${asset.dataFormat}`;

test('nothing is serialized when nothing is stored', t => {
    const vm = makeVM();
    const json = JSON.parse(vm.toJSON());
    t.notOk('glowAssets' in json, 'no glowAssets key in project.json');
    t.end();
});

test('roundtrip through saveProjectSb3 and loadProject', t => {
    const originalVM = makeVM();
    const manager = originalVM.runtime.glowAssetManager;

    loadEmptyProject(originalVM).then(() => {
        const training = manager.set('glowMl', 'training', 'json', new Uint8Array([1, 2, 3, 4]));
        manager.set('glowMidi', 'kit', 'json', new Uint8Array([5, 6]));

        const projectJSON = JSON.parse(originalVM.toJSON());
        t.same(projectJSON.glowAssets, [
            {owner: 'glowMl', name: 'training', md5ext: md5extOf(training)},
            {owner: 'glowMidi', name: 'kit', md5ext: md5extOf(manager.get('glowMidi', 'kit'))}
        ], 'project.json carries the manifest');

        return originalVM.saveProjectSb3('arraybuffer');
    }).then(projectSb3 => {
        const newVM = makeVM();
        const newManager = newVM.runtime.glowAssetManager;

        // Something already stored must not survive loading a different project.
        newManager.set('stale', 'leftover', 'json', new Uint8Array([9]));

        let changed = false;
        newManager.on('change', () => {
            changed = true;
        });

        return newVM.loadProject(projectSb3).then(() => {
            t.ok(changed, 'loadProject emits change');
            t.notOk(newManager.has('stale', 'leftover'), 'loading a project clears what was there');
            t.same(newManager.list(), [
                {ownerId: 'glowMl', name: 'training', dataFormat: 'json', byteLength: 4},
                {ownerId: 'glowMidi', name: 'kit', dataFormat: 'json', byteLength: 2}
            ], 'both entries came back');
            t.same(
                newManager.get('glowMl', 'training').data,
                new Uint8Array([1, 2, 3, 4]),
                'with their bytes intact'
            );
            t.equal(newManager.getTotalBytes(), 6, 'and the right total');
            t.end();
        });
    });
});

test('the data really is a file in the sb3, not part of project.json', t => {
    const vm = makeVM();
    const manager = vm.runtime.glowAssetManager;

    loadEmptyProject(vm).then(() => {
        const asset = manager.set('glowMl', 'training', 'json', new Uint8Array([1, 2, 3, 4, 5, 6, 7]));
        return vm.saveProjectSb3('arraybuffer').then(projectSb3 => ({asset, projectSb3}));
    }).then(({asset, projectSb3}) => JSZip.loadAsync(projectSb3).then(zip => {
        const member = zip.file(md5extOf(asset));
        t.ok(member, 'the zip has a member named after the content hash');
        return member.async('uint8array').then(data => {
            t.same(data, new Uint8Array([1, 2, 3, 4, 5, 6, 7]), 'holding the bytes we stored');
            return zip.file('project.json').async('string');
        }).then(projectJSON => {
            t.notMatch(projectJSON, '1,2,3,4,5,6,7', 'project.json does not carry the payload');
            t.match(projectJSON, asset.assetId, 'only a reference to it');
            t.end();
        });
    }));
});

test('saveProjectSb3DontZip and vm.assets include the asset', t => {
    const vm = makeVM();
    const manager = vm.runtime.glowAssetManager;

    loadEmptyProject(vm).then(() => {
        const asset = manager.set('glowMl', 'training', 'json', new Uint8Array([8, 9]));

        const files = vm.saveProjectSb3DontZip();
        t.ok(md5extOf(asset) in files, 'saveProjectSb3DontZip lists the file');
        t.same(files[md5extOf(asset)], new Uint8Array([8, 9]), 'with the right content');

        t.ok(vm.assets.includes(asset), 'vm.assets includes the asset object');
        t.ok(
            vm.serializeAssets().some(desc => desc.fileName === md5extOf(asset)),
            'vm.serializeAssets includes a file desc for it'
        );
        t.end();
    });
});

test('assets stay out of an exported sprite', t => {
    const vm = makeVM();
    const manager = vm.runtime.glowAssetManager;

    loadEmptyProject(vm).then(() => {
        // The fixture is only a stage, so make it a sprite to be able to export it.
        const sprite = vm.runtime.targets[0];
        sprite.isStage = false;

        const asset = manager.set('glowMl', 'training', 'json', new Uint8Array([1, 2, 3]));

        const spriteJSON = JSON.parse(vm.toJSON(sprite.id));
        t.notOk('glowAssets' in spriteJSON, 'sprite.json has no manifest');
        t.notOk(
            vm.serializeAssets(sprite.id).some(desc => desc.fileName === md5extOf(asset)),
            'and serializeAssets for a target lists no file for it'
        );

        return vm.exportSprite(sprite.id, 'uint8array').then(exported => JSZip.loadAsync(exported))
            .then(zip => {
                t.notOk(zip.file(md5extOf(asset)), 'so the sprite3 does not carry the file either');
                t.end();
            });
    });
});

test('importing a sprite leaves project assets alone', t => {
    const exportingVM = makeVM();

    loadEmptyProject(exportingVM).then(() => {
        // The fixture is only a stage, so make it a sprite to be able to export it.
        const sprite = exportingVM.runtime.targets[0];
        sprite.isStage = false;
        return exportingVM.exportSprite(sprite.id, 'uint8array');
    }).then(exportedSprite => {
        const vm = makeVM();
        const manager = vm.runtime.glowAssetManager;
        return loadEmptyProject(vm).then(() => {
            manager.set('glowMl', 'training', 'json', new Uint8Array([1, 2, 3]));
            return vm.addSprite(exportedSprite);
        }).then(() => {
            // deserialize() runs with keepExisting, the same as it does for fonts.
            t.ok(manager.has('glowMl', 'training'), 'still there after addSprite');
            t.equal(manager.getTotalBytes(), 3, 'and unchanged');
            t.end();
        });
    });
});

test('dispose clears the manager', t => {
    const vm = makeVM();
    const manager = vm.runtime.glowAssetManager;

    loadEmptyProject(vm).then(() => {
        manager.set('glowMl', 'training', 'json', new Uint8Array([1, 2, 3]));
        t.equal(manager.list().length, 1, 'stored');

        vm.runtime.dispose();
        t.same(manager.list(), [], 'dispose emptied it');
        t.equal(vm.runtime.glowAssetManager, manager, 'and kept the same manager instance');
        t.end();
    });
});

test('a project whose asset file is missing still loads', t => {
    const originalVM = makeVM();
    const manager = originalVM.runtime.glowAssetManager;

    loadEmptyProject(originalVM).then(() => {
        const asset = manager.set('glowMl', 'training', 'json', new Uint8Array([1, 2, 3]));
        return originalVM.saveProjectSb3('arraybuffer').then(projectSb3 => ({asset, projectSb3}));
    }).then(({asset, projectSb3}) => JSZip.loadAsync(projectSb3)
        .then(zip => {
            // Drop the payload but keep the manifest referencing it.
            zip.remove(md5extOf(asset));
            return zip.generateAsync({type: 'arraybuffer'});
        })
        .then(damagedSb3 => {
            const newVM = makeVM();
            // Do not go looking for it on the network.
            newVM.runtime.storage.load = () => Promise.reject(new Error('not available offline'));
            return newVM.loadProject(damagedSb3).then(() => {
                t.pass('the project still loaded');
                t.same(newVM.runtime.glowAssetManager.list(), [], 'without the broken asset');
                t.end();
            });
        }));
});
