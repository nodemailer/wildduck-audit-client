'use strict';

const express = require('express');
const router = new express.Router();
const Joi = require('@hapi/joi');
const { asyncifyRequest, validationErrors } = require('../lib/tools');
const { requireLogin, login, logout } = require('../lib/passport');
const db = require('../lib/db');

router.use(
    '/audits',
    requireLogin,
    (req, res, next) => {
        if (req.user.level !== 'group') {
            return next();
        }

        db.client.collection('auditgroups').findOne({ _id: req.user.audit, deleted: false, expires: { $gt: new Date() } }, (err, groupData) => {
            if (err) {
                return next(err);
            }

            if (!groupData) {
                let err = new Error('Requested audit was not found');
                err.status = 404;
                return next(err);
            }

            req.group = groupData;

            res.locals.auditName = groupData.name;

            next();
        });
    },
    require('./audits/index')
);

router.get(
    '/',
    asyncifyRequest(async (req, res) => {
        if (req.user) {
            return res.redirect('/audits');
        }

        res.render('root/index', {
            msg: 'Hello world root',
            layout: 'layouts/main'
        });
    })
);

router.get(
    '/login',
    asyncifyRequest(async (req, res) => {
        if (req.user) {
            // already logged in
            return res.redirect('/audits');
        }
        res.render('root/login', {
            mainMenuLogin: true,
            title: 'Log in',
            layout: 'layouts/main'
        });
    })
);

router.get('/logout', (req, res) => {
    req.flash(); // clear pending messages
    logout(req, res);
});

router.post('/login', (req, res, next) => {
    let loginSchema = Joi.object({
        username: Joi.string().max(256).required().example('admin').label('Username').description('Username'),
        password: Joi.string().max(256).required().example('secret').label('Password').description('Password'),
        remember: Joi.boolean().truthy('Y', 'true', '1', 'on').default(false).label('Remember me').description('Remember login in this browser')
    });

    const validationResult = loginSchema.validate(req.body, {
        stripUnknown: true,
        abortEarly: false,
        convert: true
    });

    const values = validationResult && validationResult.value;

    let showErrors = (errors, disableDefault) => {
        if (!disableDefault) {
            req.flash('danger', 'Authentication failed');
        }
        res.render('root/login', {
            mainMenuLogin: true,
            title: 'Log in',
            layout: 'layouts/main',
            values,
            errors
        });
    };

    if (validationResult.error) {
        return showErrors(validationErrors(validationResult));
    }

    login(req, res, next);
});

module.exports = router;
