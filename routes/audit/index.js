'use strict';

const moment = require('moment');
const express = require('express');
const router = new express.Router();
const { asyncifyRequest } = require('../../lib/tools');
const audits = require('../../lib/audits');
const db = require('../../lib/db');
const Joi = require('@hapi/joi');
const { ObjectID } = require('mongodb');
const ZipStream = require('zip-stream');
const util = require('util');
const { addToStream } = require('../../lib/stream');

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

const formatFilename = messageData => {
    return (
        moment((messageData && messageData.metadata && messageData.metadata.date) || new Date()).format('YYYY-MM-DD_HH-mm-ss') + '_' + messageData._id + '.eml'
    );
};

router.get(
    '/',
    asyncifyRequest(async (req, res) => {
        const validationResult = auditListingSchema.validate(req.query, {
            stripUnknown: true,
            abortEarly: false,
            convert: true
        });

        const values = validationResult && validationResult.value;
        const page = values && !validationResult.error ? values.p : 0;

        const auditData = await audits.get(req.user.audit);
        if (!auditData) {
            let err = new Error('Requested audit was not found');
            err.status = 404;
            throw err;
        }

        const data = {
            mainMenuAudit: true,
            audit: auditData,
            layout: 'layouts/main'
        };

        const now = new Date();
        values.start = values.start || moment(auditData.start || now);
        values.end = values.end || moment(auditData.end || now);

        let query = {
            'metadata.audit': auditData._id,
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

        data.listing = await audits.listMessages(auditData._id, query, page);
        data.values = Object.assign(Object.assign({}, values), {
            start: moment(values.start).format('YYYY/MM/DD'),
            end: moment(values.end).format('YYYY/MM/DD')
        });

        data.listing.data.forEach(entry => {
            let url = new URL(`audit/message/${entry._id}`, 'http://localhost');

            // keep search info for backlinks
            ['from', 'to', 'subject', 'start', 'end', 's', 'p'].forEach(key => {
                if (data.values[key]) {
                    url.searchParams.append(key, data.values[key]);
                }
            });

            entry.url = url.pathname + (url.search ? url.search : '');
        });

        if (data.listing.page < data.listing.pages) {
            let url = new URL('audit', 'http://localhost');
            url.searchParams.append('p', data.listing.page + 1);

            ['from', 'to', 'subject', 'start', 'end', 's'].forEach(key => {
                if (data.values[key]) {
                    url.searchParams.append(key, data.values[key]);
                }
            });

            data.nextPage = url.pathname + (url.search ? url.search : '');
        }

        if (data.listing.page > 1) {
            let url = new URL('audit', 'http://localhost');
            url.searchParams.append('p', data.listing.page - 1);

            ['from', 'to', 'subject', 'start', 'end', 's'].forEach(key => {
                if (data.values[key]) {
                    url.searchParams.append(key, data.values[key]);
                }
            });

            data.previousPage = url.pathname + (url.search ? url.search : '');
        }

        res.render('audit/index', data);
    })
);

router.get(
    '/message/:id',
    asyncifyRequest(async (req, res) => {
        let paramsSchema = Joi.object({
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
            layout: 'layouts/main'
        };

        data.messageData = await audits.getMessage(req.user.audit, values.id);
        if (!data.messageData) {
            let err = new Error('Requested message was not found');
            err.status = 404;
            throw err;
        }

        let url = new URL('audit', 'http://localhost');
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

        switch (info.source) {
            case 'API':
                data.info.push({ isText: true, title: 'Source', text: 'generated by webmail' });
                break;
            case 'SMTP':
                data.info.push({ isText: true, title: 'Source', text: 'uploaded  to SMTP for delivery' });
                break;
            case 'IMAP':
                data.info.push({ isText: true, title: 'Source', text: 'uploaded by IMAP client to folder' });
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
                addresses: mailFrom.map((address, i) => {
                    return {
                        address,
                        last: i === mailFrom.length - 1
                    };
                })
            });
        }

        if (info.envelope && info.envelope.to) {
            const rcptTo = [].concat(info.envelope.to || []);
            data.info.push({
                isAddress: true,
                title: 'RCPT TO',
                addresses: rcptTo.map((address, i) => {
                    return {
                        address,
                        last: i === rcptTo.length - 1
                    };
                })
            });
        }

        await addToStream(
            req.user._id,
            req.user.audit,
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

        res.render('audit/message', data);
    })
);

router.get(
    '/message/:id/download',
    asyncifyRequest(async (req, res) => {
        let paramsSchema = Joi.object({
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

        const messageData = await audits.getMessage(req.user.audit, values.id);
        if (!messageData) {
            let err = new Error('Requested message was not found');
            err.status = 404;
            throw err;
        }

        await addToStream(
            req.user._id,
            req.user.audit,
            'fetch_message',
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

        res.set('Content-Type', 'message/rfc822');
        res.setHeader('Content-disposition', `attachment; filename=${formatFilename(messageData)}`);

        const stream = await audits.stream(values.id);
        stream.pipe(res);
    })
);

router.post(
    '/download',
    asyncifyRequest(async (req, res) => {
        let paramsSchema = Joi.object({
            messages: Joi.string().empty('').required().label('Message listing'),

            subject: Joi.string().empty('').max(256).example('Hello world').label('Subject').description('Message subject'),
            from: Joi.string().empty('').max(256).example('John Doe').label('Sender').description('Sender name or address'),
            to: Joi.string().empty('').max(256).example('John Doe').label('Recipient').description('Recipient name or address'),
            start: Joi.date().empty('').example('2020/01/02').label('Start date').description('Start date'),
            end: Joi.date().empty('').greater(Joi.ref('start')).example('2020/01/02').label('End date').description('End date')
        });

        const validationResult = paramsSchema.validate(req.body, {
            stripUnknown: true,
            abortEarly: false,
            convert: true
        });

        if (validationResult.error) {
            req.flash('danger', 'Invalid message list provided');
            return res.redirect('/audit');
        }

        const values = (validationResult && validationResult.value) || {};
        const query = {
            'metadata.audit': new ObjectID(req.user.audit)
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
                    return res.redirect('/audit');
                }
                query._id = { $in: list.map(entry => new ObjectID(entry)) };
            } catch (err) {
                req.flash('danger', 'Invalid message list provided');
                return res.redirect('/audit');
            }
        }

        await addToStream(
            req.user._id,
            req.user.audit,
            'fetch_messages',
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

        const archive = new ZipStream(); // OR new packer(options)
        const addEntry = util.promisify(archive.entry.bind(archive));

        res.set('Content-Type', 'application/zip');
        res.setHeader('Content-disposition', `attachment; filename=messages.zip`);

        archive.pipe(res);

        return new Promise((resolve, reject) => {
            let errored = false;
            archive.on('error', err => {
                req.log.error({ msg: 'Archive error', err });
                errored = true;
                reject(err);
            });

            const looper = async () => {
                const cursor = await db.client.collection('audit.files').find(query, { noCursorTimeout: true, projection: { _id: true } });
                let messageData;
                while ((messageData = await cursor.next())) {
                    if (errored) {
                        return await cursor.close();
                    }
                    try {
                        const stream = await audits.stream(messageData._id);
                        await addEntry(stream, { name: formatFilename(messageData) });
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
