const EventEmitter = require('events');
const AssetUtil = require('../util/tw-asset-util');
const log = require('../util/log');

/**
 * Storage for arbitrary data belonging to an extension or an addon, kept as real
 * project assets rather than as JSON inside project.json. glow-ets/scratch-gui#22
 *
 * The difference matters for bulk data: project.json is copied in full into every
 * autosave restore point, while assets are keyed by their content hash and stored
 * once, then shared by every restore point that references them.
 *
 * Modelled on tw-font-manager.js, which is the only other producer of asset files
 * that are neither costumes nor sounds.
 */

/**
 * File formats an owner is allowed to store, mapped to their content type.
 * A whitelist rather than a blacklist: everything here has to be something a
 * consumer can meaningfully vet before using it.
 * @type {Object.<string, string>}
 */
const ALLOWED_FORMATS = {
    json: 'application/json'
};

/**
 * Describes one of our assets to scratch-storage. createAsset() does not check this
 * against scratch-storage's own AssetType registry, so we can describe our own type
 * without forking scratch-storage or mutating its shared enum. These assets always
 * travel inside the project file, so they never need a web store to load from.
 * @param {string} dataFormat - a key of ALLOWED_FORMATS
 * @returns {object} a scratch-storage AssetType
 */
const assetTypeFor = dataFormat => ({
    contentType: ALLOWED_FORMATS[dataFormat],
    name: 'GlowAsset',
    runtimeFormat: dataFormat,
    immutable: true
});

/**
 * Owner ids and asset names must look like this. Notably it excludes '/', which is
 * what lets us key the map on `owner/name` without ambiguity, and it means a name can
 * never be '__proto__' in a way that matters.
 * @type {RegExp}
 */
const NAME_REGEX = /^[\w.-]{1,64}$/;

/**
 * Refuse to store more than this in total. A classroom laptop has to survive whatever
 * a project throws at it, and an asset that cannot be saved is better than a project
 * that cannot be opened.
 * @type {number}
 */
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;

/**
 * Emit a warning once the total passes this, so an owner can start pruning before it
 * hits the ceiling.
 * @type {number}
 */
const DEFAULT_WARN_BYTES = 4 * 1024 * 1024;

/**
 * @param {string} ownerId - extension or addon id
 * @param {string} name - asset name within that owner
 * @returns {string} key into the asset map
 */
const makeKey = (ownerId, name) => `${ownerId}/${name}`;

/**
 * Byte counts end up in front of teachers and pupils, so say '10.6 MB' rather
 * than 11155908. Powers of 1024, to match how the limits are written.
 * @param {number} bytes - a byte count
 * @returns {string} the same count, readable
 */
const formatBytes = bytes => {
    if (bytes < 1024) {
        return `${bytes} bytes`;
    }
    const units = ['KB', 'MB', 'GB'];
    let value = bytes / 1024;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit++;
    }
    // One decimal place, but not a pointless '.0'.
    const rounded = Math.round(value * 10) / 10;
    return `${rounded} ${units[unit]}`;
};

class GlowAssetManager extends EventEmitter {
    /**
     * @param {Runtime} runtime - the runtime this belongs to
     */
    constructor (runtime) {
        super();

        /** @type {Runtime} */
        this.runtime = runtime;

        /**
         * Keyed by `owner/name`. A Map rather than an object so that an owner id or a
         * name can never reach Object.prototype.
         * @type {Map.<string, {ownerId: string, name: string, asset: object}>}
         */
        this.assets = new Map();

        /** @type {number} */
        this.maxBytes = DEFAULT_MAX_BYTES;

        /** @type {number} */
        this.warnBytes = DEFAULT_WARN_BYTES;

        /**
         * Whether the warning threshold has already been reported, so crossing it
         * emits once rather than on every write.
         * @type {boolean}
         */
        this._warned = false;
    }

    /** @returns {number} the default value of maxBytes */
    static get DEFAULT_MAX_BYTES () {
        return DEFAULT_MAX_BYTES;
    }

    /** @returns {number} the default value of warnBytes */
    static get DEFAULT_WARN_BYTES () {
        return DEFAULT_WARN_BYTES;
    }

    /**
     * @param {number} bytes - a byte count
     * @returns {string} the same count, readable
     */
    static formatBytes (bytes) {
        return formatBytes(bytes);
    }

    /** @returns {Array.<string>} the file formats that may be stored */
    static get ALLOWED_FORMATS () {
        return Object.keys(ALLOWED_FORMATS);
    }

    /**
     * @param {*} name - candidate owner id or asset name
     * @returns {boolean} whether it may be used
     */
    static isValidName (name) {
        return typeof name === 'string' && NAME_REGEX.test(name);
    }

    /**
     * @param {*} dataFormat - candidate file format
     * @returns {boolean} whether it is on the whitelist
     */
    static isAllowedFormat (dataFormat) {
        return typeof dataFormat === 'string' &&
            Object.prototype.hasOwnProperty.call(ALLOWED_FORMATS, dataFormat);
    }

    /**
     * Store data, replacing whatever was under the same owner and name.
     * @param {string} ownerId - extension or addon id
     * @param {string} name - asset name within that owner
     * @param {string} dataFormat - a whitelisted file format
     * @param {Uint8Array} data - the bytes to store
     * @returns {object} the created scratch-storage asset
     */
    set (ownerId, name, dataFormat, data) {
        if (!GlowAssetManager.isValidName(ownerId)) {
            throw new Error(`Invalid owner id: ${ownerId}`);
        }
        if (!GlowAssetManager.isValidName(name)) {
            throw new Error(`Invalid asset name: ${name}`);
        }
        if (!GlowAssetManager.isAllowedFormat(dataFormat)) {
            throw new Error(`Format is not allowed: ${dataFormat}`);
        }
        if (!(data instanceof Uint8Array)) {
            throw new Error('Asset data must be a Uint8Array');
        }

        const key = makeKey(ownerId, name);
        const existing = this.assets.get(key);
        const replacedBytes = existing ? existing.asset.data.byteLength : 0;
        const totalBytes = this.getTotalBytes() - replacedBytes + data.byteLength;
        if (totalBytes > this.maxBytes) {
            // Throw before storing anything, so a refused write leaves no trace.
            const error = new Error(
                `Storing ${key} would use ${formatBytes(totalBytes)}, over the limit of ` +
                `${formatBytes(this.maxBytes)}`
            );
            // On the error too, so a caller can report it without parsing the message.
            error.totalBytes = totalBytes;
            error.maxBytes = this.maxBytes;
            throw error;
        }

        const asset = this.runtime.storage.createAsset(
            assetTypeFor(dataFormat),
            dataFormat,
            data,
            null,
            true
        );
        this.assets.set(key, {ownerId, name, asset});
        this.changed();
        this._checkWarningThreshold();
        return asset;
    }

    /**
     * @param {string} ownerId - extension or addon id
     * @param {string} name - asset name within that owner
     * @returns {object|null} the stored asset, or null
     */
    get (ownerId, name) {
        const entry = this.assets.get(makeKey(ownerId, name));
        return entry ? entry.asset : null;
    }

    /**
     * @param {string} ownerId - extension or addon id
     * @param {string} name - asset name within that owner
     * @returns {boolean} whether anything is stored under that key
     */
    has (ownerId, name) {
        return this.assets.has(makeKey(ownerId, name));
    }

    /**
     * @param {string} ownerId - extension or addon id
     * @param {string} name - asset name within that owner
     * @returns {boolean} whether anything was removed
     */
    delete (ownerId, name) {
        const deleted = this.assets.delete(makeKey(ownerId, name));
        if (deleted) {
            this.changed();
            this._checkWarningThreshold();
        }
        return deleted;
    }

    /**
     * Remove everything belonging to one owner.
     * @param {string} ownerId - extension or addon id
     * @returns {number} how many assets were removed
     */
    deleteOwner (ownerId) {
        let removed = 0;
        for (const [key, entry] of this.assets) {
            if (entry.ownerId === ownerId) {
                this.assets.delete(key);
                removed++;
            }
        }
        if (removed > 0) {
            this.changed();
            this._checkWarningThreshold();
        }
        return removed;
    }

    /**
     * Describe what is stored, without handing out the assets themselves.
     * @param {string} [optOwnerId] - restrict to one owner
     * @returns {Array.<object>} one entry per asset
     */
    list (optOwnerId) {
        const entries = [];
        for (const entry of this.assets.values()) {
            if (typeof optOwnerId === 'undefined' || entry.ownerId === optOwnerId) {
                entries.push({
                    ownerId: entry.ownerId,
                    name: entry.name,
                    dataFormat: entry.asset.dataFormat,
                    byteLength: entry.asset.data.byteLength
                });
            }
        }
        return entries;
    }

    /**
     * Forget everything. Called from Runtime.dispose().
     */
    clear () {
        this.assets.clear();
        this._warned = false;
        this.changed();
    }

    /**
     * @returns {number} how many bytes are stored in total
     */
    getTotalBytes () {
        let total = 0;
        for (const entry of this.assets.values()) {
            total += entry.asset.data.byteLength;
        }
        return total;
    }

    /**
     * @param {string} ownerId - extension or addon id
     * @returns {number} how many bytes that owner is using
     */
    getBytesByOwner (ownerId) {
        let total = 0;
        for (const entry of this.assets.values()) {
            if (entry.ownerId === ownerId) {
                total += entry.asset.data.byteLength;
            }
        }
        return total;
    }

    /**
     * Emit 'warning' when the total first passes warnBytes, and arm it again once it
     * drops back below.
     * @private
     */
    _checkWarningThreshold () {
        const totalBytes = this.getTotalBytes();
        if (totalBytes > this.warnBytes) {
            if (!this._warned) {
                this._warned = true;
                this.emit('warning', {
                    totalBytes,
                    warnBytes: this.warnBytes,
                    maxBytes: this.maxBytes
                });
            }
        } else {
            this._warned = false;
        }
    }

    /**
     * Anything changed.
     */
    changed () {
        this.emit('change');
    }

    /**
     * @returns {Array.<object>|null} the manifest for project.json, or null when there
     *   is nothing to save so the key can be left out entirely
     */
    serializeJSON () {
        if (this.assets.size === 0) {
            return null;
        }
        return Array.from(this.assets.values()).map(entry => ({
            owner: entry.ownerId,
            name: entry.name,
            // The format lives in the extension, exactly as it does for fonts, so
            // there is no second copy of it to disagree with the filename.
            md5ext: `${entry.asset.assetId}.${entry.asset.dataFormat}`
        }));
    }

    /**
     * @returns {Array.<object>} the assets themselves, for the project zip
     */
    serializeAssets () {
        return Array.from(this.assets.values()).map(entry => entry.asset);
    }

    /**
     * Load a manifest produced by serializeJSON(). Never throws: a project with a
     * broken asset must still open, minus that asset.
     * @param {*} json - the manifest, from an untrusted project file
     * @param {JSZip} zip - the project archive, if there is one
     * @param {boolean} keepExisting - true when importing a sprite into a project
     * @returns {Promise.<void>} resolves when every entry has been dealt with
     */
    async deserialize (json, zip, keepExisting) {
        if (!keepExisting) {
            this.clear();
        }

        if (Array.isArray(json)) {
            let reportedLimit = false;

            for (const entry of json) {
                if (!entry || typeof entry !== 'object') {
                    continue;
                }

                try {
                    const ownerId = entry.owner;
                    const name = entry.name;
                    const md5ext = entry.md5ext;
                    if (
                        typeof md5ext !== 'string' ||
                        !GlowAssetManager.isValidName(ownerId) ||
                        !GlowAssetManager.isValidName(name) ||
                        this.has(ownerId, name)
                    ) {
                        continue;
                    }

                    const dataFormat = md5ext.slice(md5ext.lastIndexOf('.') + 1).toLowerCase();
                    if (!GlowAssetManager.isAllowedFormat(dataFormat)) {
                        continue;
                    }

                    const asset = await AssetUtil.getByMd5ext(
                        this.runtime,
                        zip,
                        assetTypeFor(dataFormat),
                        md5ext
                    );

                    // storage.load() resolves null rather than rejecting when nothing
                    // has the asset, so a file missing from the zip arrives here as
                    // null rather than as an error.
                    if (!asset || !(asset.data instanceof Uint8Array)) {
                        log.error(`glow assets: ${md5ext} is missing from the project`);
                        continue;
                    }

                    // The ceiling applies to what a project file asks us to load too,
                    // otherwise a crafted project could exhaust memory.
                    if (this.getTotalBytes() + asset.data.byteLength > this.maxBytes) {
                        if (!reportedLimit) {
                            reportedLimit = true;
                            log.warn(
                                `glow assets: project is over the ${formatBytes(this.maxBytes)} limit, ` +
                                `skipping the rest`
                            );
                        }
                        continue;
                    }

                    this.assets.set(makeKey(ownerId, name), {ownerId, name, asset});
                } catch (e) {
                    log.error('could not load glow asset', e);
                }
            }
        }

        this._checkWarningThreshold();
        this.changed();
    }
}

module.exports = GlowAssetManager;
