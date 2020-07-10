'use strict';

const moment = require('moment');
const express = require('express');
const router = new express.Router();
const { asyncifyRequest } = require('../../lib/tools');
const audits = require('../../lib/audits');
const Joi = require('@hapi/joi');

router.get(
    '/',
    asyncifyRequest(async (req, res) => {
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

module.exports = router;
