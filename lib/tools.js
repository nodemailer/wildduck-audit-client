'use strict';

const openpgp = require('openpgp');
const config = require('wild-config');
const pkg = require('../package.json');
const fs = require('fs');

const signingKeyFile = fs.readFileSync(config.app.pgp.sign.key, 'utf-8');
let signFinger;
let signingKey;
let signPubKey;

openpgp
    .readKey({ armoredKey: signingKeyFile })
    .then(key => {
        if (!config.app.pgp.sign.password) {
            return key;
        }

        return openpgp.decryptKey({
            privateKey: key,
            passphrase: config.app.pgp.sign.password
        });
    })
    .then(key => {
        signingKey = key;
        signPubKey = key.toPublic().armor();
        signFinger = key.getFingerprint().substr(-16).toUpperCase();
    })
    .catch(err => {
        throw err;
    });

openpgp.config.commentString = config.app.pgp.comment || 'https://wildduck.email';
openpgp.config.versionString = config.app.pgp.version || `WildDuck Audit v${pkg.version}`;
openpgp.config.preferredHashAlgorithm = openpgp.enums.hash[config.app.hash.algo || 'sha256'];

const asyncifyRequest = middleware => async (req, res, next) => {
    try {
        await middleware(req, res, next);
    } catch (err) {
        req.log.error({ msg: 'Failed to process request', req, res, err });
        next(err);
    }
};

const asyncifyJson = middleware => async (req, res, next) => {
    try {
        await middleware(req, res, next);
    } catch (err) {
        let data = {
            error: err.message
        };

        if (err.responseCode) {
            res.status(err.responseCode);
        }

        if (err.code) {
            data.code = err.code;
        }

        req.log.error({ msg: 'Failed to process request', req, res, err });

        res.charSet('utf-8');
        res.json(data);
        return next();
    }
};

const validationErrors = validationResult => {
    const errors = {};
    if (validationResult.error && validationResult.error.details) {
        validationResult.error.details.forEach(detail => {
            if (!errors[detail.path]) {
                errors[detail.path] = detail.message;
            }
        });
    }
    return errors;
};

const signCleartext = async (cleartext, date) => {
    const unsignedMessage = await openpgp.createCleartextMessage({ text: cleartext });
    const cleartextMessage = await openpgp.sign({
        message: unsignedMessage, // CleartextMessage or Message object
        signingKeys: signingKey,
        date,
        config: { preferredHashAlgorithm: 8 }
    });

    return cleartextMessage;
};

module.exports = {
    asyncifyRequest,
    asyncifyJson,
    validationErrors,
    signCleartext,
    signFinger: () => signFinger,
    signPubKey: () => signPubKey
};
