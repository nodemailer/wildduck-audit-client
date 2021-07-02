'use strict';

const config = require('wild-config');
const moment = require('moment');
const express = require('express');
const router = new express.Router();
const { asyncifyRequest, signFinger, signPubKey } = require('../../lib/tools');
const audits = require('../../lib/audits');
const db = require('../../lib/db');
const Joi = require('@hapi/joi');
const { ObjectID } = require('mongodb');
const ZipStream = require('zip-stream');
const util = require('util');
const { addToStream } = require('../../lib/stream');
const humanize = require('humanize');
const Hasher = require('../../lib/hasher');

let auditListingSchema = Joi.object({
    p: Joi.number()
        .empty('')
        .min(1)
        .max(64 * 1024)
        .default(1)
        .example(1)
        .label('Page Number'),

    s: Joi.string().empty('').max(1),
    subject: Joi.string().empty('').max(256).example('Hello world').label('Subject').description('Message subject'),
    from: Joi.string().empty('').max(256).example('John Doe').label('Sender').description('Sender name or address'),
    to: Joi.string().empty('').max(256).example('John Doe').label('Recipient').description('Recipient name or address'),

    start: Joi.date().empty('').example('2020/01/02').label('Start date').description('Start date'),
    end: Joi.date().empty('').greater(Joi.ref('start')).example('2020/01/02').label('End date').description('End date')
});

const formatFilename = messageData =>
    'messages-' +
    moment((messageData && messageData.metadata && messageData.metadata.date) || new Date()).format('YYYY-MM-DD_HH-mm-ss') +
    '_' +
    messageData._id +
    '.eml';

const loadAuditAsync = async (req, res) => {
    if (!req.params.audit) {
        return;
    }

    if (!/^[0-9a-f]{24}$/.test(req.params.audit)) {
        let err = new Error('Invalid audit ID');
        err.status = 400;
        throw err;
    }

    switch (req.user.level) {
        case 'group': {
            let auditData = await audits.get(req.params.audit);
            if (auditData && auditData.meta && auditData.meta.group.equals(req.user.audit)) {
                req.auditData = await audits.get(req.params.audit);
            }
            break;
        }

        case 'audit':
        default:
            if (!req.user.audit || req.params.audit !== req.user.audit.toString()) {
                let err = new Error('Can not access requested data');
                err.status = 503;
                throw err;
            }
            req.auditData = await audits.get(req.params.audit);
            break;
    }

    if (!req.auditData) {
        let err = new Error('Requested audit was not found');
        err.status = 404;
        throw err;
    }

    res.locals.audit = req.auditData;
    req.audit = req.auditData._id;
};

const loadAudit = (req, res, next) => {
    loadAuditAsync(req, res)
        .then(() => {
            next();
        })
        .catch(err => next(err));
};

router.get(
    '/',
    asyncifyRequest(async (req, res) => {
        const data = {
            mainMenuAudit: true,
            layout: 'layouts/main'
        };

        data.auditList = await audits.listAudits(req.user.audit, req.user.level);

        res.render('audits/index', data);
    })
);

router.get(
    '/signPubKey/:key',
    asyncifyRequest(async (req, res) => {
        res.set('Content-Type', 'text/plain');
        res.setHeader('Content-disposition', `attachment; filename=${signFinger()}.asc`);
        res.send(Buffer.from(signPubKey()));
    })
);

router.get(
    '/audit/:audit',
    loadAudit,
    asyncifyRequest(async (req, res) => {
        let paramsSchema = Joi.object({
            audit: Joi.string().empty('').hex().length(24).required().label('Audit ID')
        })
            // needed for backlink
            .concat(auditListingSchema);

        const validationResult = paramsSchema.validate(Object.assign(Object.assign({}, req.params || {}), req.query), {
            stripUnknown: true,
            abortEarly: false,
            convert: true
        });

        const values = validationResult && validationResult.value;
        const page = values && !validationResult.error ? values.p : 0;

        const data = {
            mainMenuAudit: true,
            layout: 'layouts/main'
        };

        const now = new Date();
        values.start = values.start || moment(req.auditData.start || now);
        values.end = values.end || moment(req.auditData.end || now);

        let query = {
            'metadata.audit': req.auditData._id,
            $and: []
        };

        if (values.subject) {
            let regex = values.subject.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
            query.$and.push({
                'metadata.subject': {
                    $regex: regex,
                    $options: 'i'
                }
            });
        }

        ['from', 'to'].forEach(key => {
            if (values[key]) {
                let regex = values[key].replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
                let type;
                switch (key) {
                    case 'from':
                        type = key;
                        break;
                    case 'to':
                        type = { $in: ['to', 'cc', 'bcc'] };
                        break;
                    default:
                        return;
                }
                query.$and.push({
                    [`metadata.addresses`]: {
                        $elemMatch: {
                            type,
                            $or: [
                                {
                                    name: {
                                        $regex: regex,
                                        $options: 'i'
                                    }
                                },
                                {
                                    address: {
                                        $regex: regex,
                                        $options: 'i'
                                    }
                                }
                            ]
                        }
                    }
                });
            }
        });

        if (values.start) {
            query.$and.push({
                'metadata.date': {
                    $gte: moment(values.start).toDate()
                }
            });
        }

        if (values.end) {
            query.$and.push({
                'metadata.date': {
                    $lte: moment(values.end).toDate()
                }
            });
        }

        data.listing = await audits.listMessages(req.auditData._id, query, page);
        data.values = Object.assign(Object.assign({}, values), {
            start: moment(values.start).format('YYYY/MM/DD'),
            end: moment(values.end).format('YYYY/MM/DD')
        });

        data.listing.data.forEach(entry => {
            let url = new URL(`/audits/audit/${values.audit}/message/${entry._id}`, 'http://localhost');

            // keep search info for backlinks
            ['from', 'to', 'subject', 'start', 'end', 's', 'p'].forEach(key => {
                if (data.values[key]) {
                    url.searchParams.append(key, data.values[key]);
                }
            });

            entry.url = url.pathname + (url.search ? url.search : '');
        });

        if (data.listing.page < data.listing.pages) {
            let url = new URL(`/audits/audit/${values.audit}`, 'http://localhost');
            url.searchParams.append('p', data.listing.page + 1);

            ['from', 'to', 'subject', 'start', 'end', 's'].forEach(key => {
                if (data.values[key]) {
                    url.searchParams.append(key, data.values[key]);
                }
            });

            data.nextPage = url.pathname + (url.search ? url.search : '');
        }

        if (data.listing.page > 1) {
            let url = new URL(`/audits/audit/${values.audit}`, 'http://localhost');
            url.searchParams.append('p', data.listing.page - 1);

            ['from', 'to', 'subject', 'start', 'end', 's'].forEach(key => {
                if (data.values[key]) {
                    url.searchParams.append(key, data.values[key]);
                }
            });

            data.previousPage = url.pathname + (url.search ? url.search : '');
        }

        if (values.s) {
            data.searchTab = true;
        } else {
            data.infoTab = true;
        }

        res.render('audits/audit', data);
    })
);

router.get(
    '/audit/:audit/logs',
    loadAudit,
    asyncifyRequest(async (req, res) => {
        let paramsSchema = Joi.object({
            audit: Joi.string().empty('').hex().length(24).required().label('Audit ID'),
            p: Joi.number()
                .empty('')
                .min(1)
                .max(64 * 1024)
                .default(1)
                .example(1)
                .label('Page Number')
        });

        const validationResult = paramsSchema.validate(Object.assign(Object.assign({}, req.params || {}), req.query), {
            stripUnknown: true,
            abortEarly: false,
            convert: true
        });

        const values = validationResult && validationResult.value;
        const page = values && !validationResult.error ? values.p : 0;

        const data = {
            mainMenuAudit: true,
            layout: 'layouts/main',
            logsTab: true,
            signFinger: signFinger()
        };

        data.listing = await audits.listLogs(req.auditData._id, page);

        if (data.listing.page < data.listing.pages) {
            let url = new URL(`/audits/audit/${values.audit}/logs`, 'http://localhost');
            url.searchParams.append('p', data.listing.page + 1);

            data.nextPage = url.pathname + (url.search ? url.search : '');
        }

        if (data.listing.page > 1) {
            let url = new URL(`/audits/audit/${values.audit}/logs`, 'http://localhost');
            url.searchParams.append('p', data.listing.page - 1);

            data.previousPage = url.pathname + (url.search ? url.search : '');
        }

        res.render('audits/logs', data);
    })
);

router.get(
    '/audit/:audit/logs/:id/download',
    loadAudit,
    asyncifyRequest(async (req, res) => {
        let paramsSchema = Joi.object({
            audit: Joi.string().empty('').hex().length(24).required().label('Audit ID'),
            id: Joi.string().empty('').hex().length(24).required().label('Log entry ID')
        });

        const validationResult = paramsSchema.validate(Object.assign(Object.assign({}, req.params || {}), req.query), {
            stripUnknown: true,
            abortEarly: false,
            convert: true
        });

        if (validationResult.error) {
            let err = new Error('Invalid message ID provided');
            err.status = 422;
            throw err;
        }

        const values = (validationResult && validationResult.value) || {};

        const logData = await audits.getSignedLog(req.audit, values.id);
        if (!logData) {
            let err = new Error('Requested log entry was not found');
            err.status = 404;
            throw err;
        }

        const fileName = logData.metadata.fileName + '.asc';

        res.set('Content-Type', 'message/rfc822');
        res.setHeader('Content-disposition', `attachment; filename=${fileName}`);

        res.end(logData.signed);
    })
);

router.get(
    '/audit/:audit/message/:id',
    loadAudit,
    asyncifyRequest(async (req, res) => {
        let paramsSchema = Joi.object({
            audit: Joi.string().empty('').hex().length(24).required().label('Audit ID'),
            id: Joi.string().empty('').hex().length(24).required().label('User ID')
        })
            // needed for backlink
            .concat(auditListingSchema);

        const validationResult = paramsSchema.validate(Object.assign(Object.assign({}, req.params || {}), req.query), {
            stripUnknown: true,
            abortEarly: false,
            convert: true
        });

        if (validationResult.error) {
            let err = new Error('Invalid message ID provided');
            err.status = 422;
            throw err;
        }

        const values = (validationResult && validationResult.value) || {};

        const data = {
            title: 'subject',
            mainMenuAudit: true,
            layout: 'layouts/main',
            audit: req.auditData
        };

        data.messageData = await audits.getMessage(req.auditData._id, values.id);
        if (!data.messageData) {
            let err = new Error('Requested message was not found');
            err.status = 404;
            throw err;
        }

        let url = new URL(`/audits/audit/${values.audit}`, 'http://localhost');
        ['from', 'to', 'subject', 'start', 'end', 's', 'p'].forEach(key => {
            if (values[key]) {
                if (['start', 'end'].includes(key)) {
                    url.searchParams.append(key, moment(values[key]).format('YYYY/MM/DD'));
                } else {
                    url.searchParams.append(key, values[key]);
                }
            }
        });
        data.auditUrl = url.pathname + (url.search ? url.search : '');

        let metadata = data.messageData.metadata || {};
        let info = metadata.info || {};

        data.info = [];

        if (data.messageData.display.subject) {
            data.info.push({ isText: true, title: 'Subject', text: data.messageData.display.subject });
        }

        let addresses = {};
        (metadata.addresses || []).forEach(entry => {
            if (!addresses[entry.type]) {
                addresses[entry.type] = [];
            }
            addresses[entry.type].push(entry);
        });

        ['from', 'to', 'cc', 'bcc'].forEach(key => {
            let title = key.replace(/^./, c => c.toUpperCase());
            if (addresses[key] && addresses[key].length) {
                addresses[key][addresses[key].length - 1].last = true;
                data.info.push({ key, isAddress: true, title, addresses: addresses[key] });
            }
        });

        data.info.push({ isText: true, title: 'Message-ID', text: metadata.msgid });

        if (metadata.ha) {
            data.info.push({ isText: true, title: 'Attachments', text: 'yes' });
        }

        if (metadata.date) {
            data.info.push({ isDate: true, title: 'Date', date: metadata.date.toISOString() });
        }

        if (metadata.mailboxPath) {
            data.info.push({ isText: true, title: 'Folder', text: metadata.mailboxPath });
        }
        if (data.messageData.length) {
            data.info.push({
                isText: true,
                title: 'Size',
                tooltip: `${data.messageData.length} bytes`,
                text: humanize.filesize(data.messageData.length, 1024, 0, '.', ' ')
            });
        }

        switch (info.source) {
            case 'API':
                data.info.push({ isText: true, title: 'Source', text: 'generated by webmail' });
                break;
            case 'SMTP':
                data.info.push({ isText: true, title: 'Source', text: 'uploaded to SMTP for delivery' });
                break;
            case 'IMAP':
                data.info.push({ isText: true, title: 'Source', text: 'uploaded via IMAP' });
                break;
            case 'MX':
                data.info.push({ isText: true, title: 'Source', text: 'received through MX' });
                break;
        }

        if (info.envelope && info.envelope.from) {
            const mailFrom = [].concat(info.envelope.from || []);
            data.info.push({
                isAddress: true,
                title: 'MAIL FROM',
                addresses: mailFrom.map((address, i) => ({
                    address,
                    last: i === mailFrom.length - 1
                }))
            });
        }

        if (info.envelope && info.envelope.to) {
            const rcptTo = [].concat(info.envelope.to || []);
            data.info.push({
                isAddress: true,
                title: 'RCPT TO',
                addresses: rcptTo.map((address, i) => ({
                    address,
                    last: i === rcptTo.length - 1
                }))
            });
        }

        await addToStream(
            req.user._id,
            req.audit,
            'view_message',
            Object.assign(
                {
                    owner: {
                        _id: req.user._id,
                        username: req.user.username,
                        name: req.user.name
                    },
                    ip: req.ip
                },
                values
            )
        );

        res.render('audits/message', data);
    })
);

router.get(
    '/audit/:audit/message/:id/download',
    loadAudit,
    asyncifyRequest(async (req, res) => {
        let paramsSchema = Joi.object({
            audit: Joi.string().empty('').hex().length(24).required().label('Audit ID'),
            id: Joi.string().empty('').hex().length(24).required().label('User ID')
        })
            // needed for backlink
            .concat(auditListingSchema);

        const validationResult = paramsSchema.validate(Object.assign(Object.assign({}, req.params || {}), req.query), {
            stripUnknown: true,
            abortEarly: false,
            convert: true
        });

        if (validationResult.error) {
            let err = new Error('Invalid message ID provided');
            err.status = 422;
            throw err;
        }

        const values = (validationResult && validationResult.value) || {};

        const messageData = await audits.getMessage(req.audit, values.id);
        if (!messageData) {
            let err = new Error('Requested message was not found');
            err.status = 404;
            throw err;
        }

        const hasher = new Hasher(config.app.hash.algo);

        const curtime = new Date();

        const fileName = formatFilename(messageData);

        hasher.once('end', () => {
            addToStream(
                req.user._id,
                req.audit,
                'fetch_messages',
                Object.assign({}, values, {
                    type: 'single',
                    fileName,
                    algo: hasher.algo,
                    hash: hasher.hash,
                    bytes: hasher.bytes,
                    messageCount: 1,
                    curtime,
                    owner: {
                        _id: req.user._id,
                        username: req.user.username,
                        name: req.user.name
                    },
                    ip: req.ip
                })
            ).catch(err => {
                req.log.error({ msg: 'Stream error', err });
            });
        });

        res.set('Content-Type', 'message/rfc822');
        res.setHeader('Content-disposition', `attachment; filename=${fileName}`);

        const stream = await audits.stream(values.id);
        stream.pipe(hasher).pipe(res);
    })
);

router.post(
    '/audit/:audit/download',
    loadAudit,
    asyncifyRequest(async (req, res) => {
        let paramsSchema = Joi.object({
            audit: Joi.string().empty('').hex().length(24).required().label('Audit ID'),

            messages: Joi.string().empty('').required().label('Message listing'),

            subject: Joi.string().empty('').max(256).example('Hello world').label('Subject').description('Message subject'),
            from: Joi.string().empty('').max(256).example('John Doe').label('Sender').description('Sender name or address'),
            to: Joi.string().empty('').max(256).example('John Doe').label('Recipient').description('Recipient name or address'),
            start: Joi.date().empty('').example('2020/01/02').label('Start date').description('Start date'),
            end: Joi.date().empty('').greater(Joi.ref('start')).example('2020/01/02').label('End date').description('End date')
        });

        const validationResult = paramsSchema.validate(Object.assign(Object.assign({}, req.params || {}), req.body), {
            stripUnknown: true,
            abortEarly: false,
            convert: true
        });

        if (validationResult.error) {
            req.flash('danger', 'Invalid message list provided');
            return res.redirect(`/audits`);
        }

        const values = (validationResult && validationResult.value) || {};
        const query = {
            'metadata.audit': new ObjectID(req.audit)
        };

        if (values.messages === 'matching') {
            query.$and = [];

            if (values.subject) {
                let regex = values.subject.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
                query.$and.push({
                    'metadata.subject': {
                        $regex: regex,
                        $options: 'i'
                    }
                });
            }

            ['from', 'to'].forEach(key => {
                if (values[key]) {
                    let regex = values[key].replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
                    let type;
                    switch (key) {
                        case 'from':
                            type = key;
                            break;
                        case 'to':
                            type = { $in: ['to', 'cc', 'bcc'] };
                            break;
                        default:
                            return;
                    }
                    query.$and.push({
                        [`metadata.addresses`]: {
                            $elemMatch: {
                                type,
                                $or: [
                                    {
                                        name: {
                                            $regex: regex,
                                            $options: 'i'
                                        }
                                    },
                                    {
                                        address: {
                                            $regex: regex,
                                            $options: 'i'
                                        }
                                    }
                                ]
                            }
                        }
                    });
                }
            });

            if (values.start) {
                query.$and.push({
                    'metadata.date': {
                        $gte: moment(values.start).toDate()
                    }
                });
            }

            if (values.end) {
                query.$and.push({
                    'metadata.date': {
                        $lte: moment(values.end).toDate()
                    }
                });
            }
        } else if (values.messages !== 'all') {
            try {
                let list = JSON.parse(values.messages);
                const listSchema = Joi.array().items(Joi.string().hex().length(24)).min(1).required();
                const listResult = listSchema.validate(list);
                if (listResult.error) {
                    req.flash('danger', 'Invalid message list provided');
                    return res.redirect(`/audits/audit/${values.audit}`);
                }
                query._id = { $in: list.map(entry => new ObjectID(entry)) };
            } catch (err) {
                req.flash('danger', 'Invalid message list provided');
                return res.redirect(`/audits/audit/${values.audit}`);
            }
        }

        const archive = new ZipStream(); // OR new packer(options)
        const addEntry = util.promisify(archive.entry.bind(archive));

        const hasher = new Hasher(config.app.hash.algo);

        const curtime = new Date();
        const fileName = `messages-${curtime
            .toISOString()
            .substr(0, 19)
            .replace(/[^0-9]+/g, '-')}_query.zip`;

        let messageCount = 0;

        res.set('Content-Type', 'application/zip');
        res.setHeader('Content-disposition', `attachment; filename=${fileName}`);

        archive.pipe(hasher).pipe(res);

        hasher.once('end', () => {
            addToStream(
                req.user._id,
                req.audit,
                'fetch_messages',
                Object.assign({}, values, {
                    type: 'query',
                    fileName,
                    algo: hasher.algo,
                    hash: hasher.hash,
                    bytes: hasher.bytes,
                    messageCount,
                    curtime,
                    owner: {
                        _id: req.user._id,
                        username: req.user.username,
                        name: req.user.name
                    },
                    ip: req.ip
                })
            ).catch(err => {
                req.log.error({ msg: 'Stream error', err });
            });
        });

        return new Promise((resolve, reject) => {
            let errored = false;
            archive.on('error', err => {
                req.log.error({ msg: 'Archive error', err });
                errored = true;
                reject(err);
            });

            const looper = async () => {
                const cursor = await db.gridfs.collection('audit.files').find(query, { noCursorTimeout: true, projection: { _id: true } });
                let messageData;
                while ((messageData = await cursor.next())) {
                    if (errored) {
                        return await cursor.close();
                    }
                    try {
                        const stream = await audits.stream(messageData._id);
                        await addEntry(stream, { name: formatFilename(messageData) });
                        messageCount++;
                    } catch (err) {
                        req.log.error({ msg: 'Failed to add file to archive', err });
                    }
                }
                await cursor.close();

                try {
                    archive.finish();
                } catch (err) {
                    req.log.error({ msg: 'Failed to finalize archive', err });
                }
            };

            looper().then(resolve).catch(reject);
        });
    })
);

module.exports = router;
