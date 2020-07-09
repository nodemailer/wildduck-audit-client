'use strict';

const express = require('express');
const router = new express.Router();
const { asyncifyRequest } = require('../../lib/tools');
const audits = require('../../lib/audits');

router.get(
    '/',
    asyncifyRequest(async (req, res) => {
        const auditData = await audits.get(req.user.audit);
        if (!auditData) {
            let err = new Error('Requested audit was not found');
            err.status = 404;
            throw err;
        }

        res.render('audit/index', {
            mainMenuAudit: true,
            audit: auditData,
            layout: 'layouts/main'
        });
    })
);

module.exports = router;
