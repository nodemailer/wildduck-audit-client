'use strict';

const moment = require('moment');
const express = require('express');
const router = new express.Router();
const { asyncifyRequest } = require('../../lib/tools');
const audits = require('../../lib/audits');
const Joi = require('@hapi/joi');

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

        console.log(require('util').inspect(query, false, 22));

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

        console.log(require('util').inspect(data, false, 22));
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

        res.render('audit/message', data);
    })
);

module.exports = router;
