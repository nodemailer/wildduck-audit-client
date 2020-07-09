'use strict';

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
                .label('Page Number')
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

        data.listing = await audits.listMessages(auditData._id, page);

        if (data.listing.page < data.listing.pages) {
            let url = new URL('audit', 'http://localhost');
            url.searchParams.append('p', data.listing.page + 1);
            data.nextPage = url.pathname + (url.search ? url.search : '');
        }

        if (data.listing.page > 1) {
            let url = new URL('audit', 'http://localhost');
            url.searchParams.append('p', data.listing.page - 1);
            data.previousPage = url.pathname + (url.search ? url.search : '');
        }
        console.log(require('util').inspect(data, false, 22));
        res.render('audit/index', data);
    })
);

module.exports = router;
