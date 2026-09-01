/**
 * Fail with an explanation instead of hundreds of confusing assertion failures
 * when the tests are run on a Node that is too old. glow-ets/scratch-gui#22
 *
 * The suite needs the `navigator` global, which arrived in Node 21, and `fetch`,
 * which arrived in Node 18. Without them src/engine/tw-frame-loop.js throws from
 * runtime.start(), so every test that loads a project fails as
 * "navigator is not defined" or as an unrelated-looking "test unfinished".
 */
const fs = require('fs');
const path = require('path');

const required = parseInt(fs.readFileSync(path.join(__dirname, '..', '.nvmrc'), 'utf8').trim(), 10);
const actual = parseInt(process.versions.node.split('.')[0], 10);

if (actual < required) {
    process.stderr.write(
        `\nThis project needs Node ${required} or newer; this is Node ${process.versions.node}.\n` +
        `Older versions have no global 'navigator', which tw-frame-loop.js uses unguarded, so\n` +
        `most of the test suite fails for reasons that have nothing to do with your changes.\n\n` +
        `    nvm use\n\n` +
        `picks up the version in .nvmrc.\n\n`
    );
    process.exit(1);
}
