'use strict';

const crypto = require('crypto');
const Transform = require('stream').Transform;

class Hasher extends Transform {
    constructor(options) {
        super();

        options = options || {};

        this.algo = options.algo || 'sha256';

        this.bytes = 0;
        this.hash = false;
        this._hash = crypto.createHash(this.algo);
    }

    _transform(chunk, encoding, done) {
        if (typeof chunk === 'string') {
            chunk = Buffer.from(chunk, encoding);
        }

        if (!chunk || !chunk.length) {
            return done();
        }

        this.bytes += chunk.length;
        this._hash.update(chunk);

        this.push(chunk);

        done();
    }

    _flush(done) {
        this.hash = this._hash.digest('hex');
        done();
    }
}

module.exports = Hasher;
