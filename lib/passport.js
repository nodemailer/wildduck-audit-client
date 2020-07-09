'use strict';

const logger = require('./logger').child({ component: 'passport' });
const util = require('util');
const db = require('./db');
const passport = require('passport');
const LocalStrategy = require('passport-local').Strategy;
const pbkdf2 = require('@phc/pbkdf2');
const { ObjectID } = require('mongodb');

const authenticate = async (username, password, session, ip) => {
    const userData = await db.client.collection('auditusers').findOne({ username });

    if (!userData || !userData.password || userData.deleted) {
        logger.info({ msg: 'Authentication', result: 'invalid_username', username, session, ip });
        return false;
    }

    try {
        const verified = await pbkdf2.verify(userData.password, password);
        if (!verified) {
            throw new Error('Not verified');
        }
    } catch (err) {
        logger.info({ msg: 'Authentication', result: 'fail', username, password, session, ip });
        return false;
    }

    logger.info({ msg: 'Authentication', result: 'success', username, session, ip });
    return userData;
};

module.exports.setup = app => {
    app.use(passport.initialize());
    app.use(passport.session());
};

module.exports.logout = (req, res) => {
    if (req.user) {
        req.flash('success', `${req.user.name} logged out`);
        req.logout();
    }
    res.redirect('/');
};

module.exports.login = (req, res, next) => {
    passport.authenticate('local', (err, user, info) => {
        if (err) {
            logger.error({ msg: 'Authentication failed', username: req.body.username, err });
            req.flash('danger', 'Authentication error');
            return next(err);
        }

        if (!user) {
            req.flash('danger', (info && info.message) || 'Failed to authenticate user');
            return res.redirect(`/login`);
        }

        req.logIn(user, err => {
            if (err) {
                return next(err);
            }

            if (req.body.remember) {
                // Cookie expires after 30 days
                req.session.cookie.maxAge = 30 * 24 * 60 * 60 * 1000;
            } else {
                // Cookie expires at end of session
                req.session.cookie.expires = false;
            }

            req.flash('success', util.format('Logged in as %s', user.name));
            return res.redirect('/audit');
        });
    })(req, res, next);
};

module.exports.requireLogin = (req, res, next) => {
    if (!req.user) {
        return res.redirect(`/login`);
    }
    next();
};

passport.use(
    new LocalStrategy(
        {
            passReqToCallback: true
        },
        (req, username, password, next) => {
            req.session.regenerate(() => {
                authenticate(username, password, req.session.id, req.ip)
                    .then(user => {
                        if (!user) {
                            return next(null, false, {
                                message: 'Incorrect username or password'
                            });
                        }
                        next(null, user);
                    })
                    .catch(next);
            });
        }
    )
);

passport.serializeUser((userData, next) => {
    next(null, userData._id.toString());
});

passport.deserializeUser((id, next) => {
    db.client
        .collection('auditusers')
        .findOne({ _id: new ObjectID(id) })
        .then(userData => {
            if (!userData || userData.deleted) {
                return next(null, {});
            }
            return next(null, userData);
        })
        .catch(next);
});
