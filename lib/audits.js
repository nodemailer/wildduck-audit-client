'use strict';

const db = require('./db');
const logger = require('./logger').child('audit');
const UserHandler = require('wildduck/lib/user-handler');
const AuditHandler = require('wildduck/lib/audit-handler');
const { ObjectID } = require('mongodb');

class Audits {
    constructor() {
        this.pageLimit = 20;
    }

    init() {
        this.auditHandler = new AuditHandler({
            database: db.client,
            users: db.users,
            gridfs: db.gridfs,
            bucket: 'audit',
            loggelf: message => logger.info(message)
        });

        this.userHandler = new UserHandler({
            database: db.client,
            users: db.users,
            gridfs: db.gridfs,
            redis: db.redis,
            loggelf: message => logger.info(message)
        });
    }

    getAuditDisplay(auditData) {
        let name = (auditData.userData && auditData.userData.name) || (auditData.meta && (auditData.meta.name || auditData.meta.username));
        let address = (auditData.userData && auditData.userData.address) || (auditData.meta && auditData.meta.address);

        let status;
        let now = new Date();
        switch (auditData.import.status) {
            case 'queued':
            case 'importing':
                status = {
                    title: 'preparing',
                    type: 'light'
                };
                break;
            default:
                if (auditData.expires < now) {
                    status = {
                        title: 'expired',
                        type: 'dark'
                    };
                } else if (auditData.start && auditData.start > now) {
                    status = {
                        title: 'delayed',
                        type: 'info'
                    };
                } else if (auditData.end && auditData.end < now) {
                    status = {
                        title: 'stopped',
                        type: 'secondary'
                    };
                } else {
                    status = {
                        title: 'enabled',
                        type: 'success'
                    };
                }

                break;
        }

        return {
            name: name || address,
            address,
            username: (auditData.userData && auditData.userData.username) || (auditData.meta && auditData.meta.username),
            start: auditData.start ? auditData.start.toISOString() : '',
            end: auditData.end ? auditData.end.toISOString() : '',
            expires: auditData.expires ? auditData.expires.toISOString() : '',

            status
        };
    }

    async get(id) {
        if (typeof id === 'string') {
            id = new ObjectID(id);
        }

        const now = new Date();
        const auditData = await db.client.collection('audits').findOne({ _id: id, deleted: false, expires: { $gt: now } });
        if (!auditData) {
            return false;
        }
        let userData = await db.users
            .collection('users')
            .findOne({ _id: auditData.user }, { projection: { _id: true, username: true, name: true, address: true } });
        if (userData) {
            auditData.userData = userData;
        }

        auditData.display = this.getAuditDisplay(auditData);

        return auditData;
    }

    async resolveUser(account) {
        return await this.userHandler.asyncGet(account, { username: true, address: true, name: true });
    }

    getAuditMessageDisplay(messageData) {
        const metadata = messageData.metadata || {};
        const header = metadata.header || {};
        const info = metadata.info || {};

        let data = {
            subject: metadata.subject || header.subject,
            source: info.source,
            date: metadata.date && metadata.date.toISOString(),
            attachments: metadata.ha,
            mailbox: metadata.mailboxPath,
            from: metadata.addresses && metadata.addresses.filter(addr => addr.type === 'from'),
            to: metadata.addresses && metadata.addresses.filter(addr => ['to', 'cc', 'bcc'].includes(addr.type))
        };

        return data;
    }

    async listMessages(audit, page) {
        const query = { 'metadata.audit': audit };

        const count = await db.client.collection('audit.files').countDocuments(query);
        const pages = Math.max(Math.ceil(count / this.pageLimit), 1);

        page = Math.min(page || 1, pages);
        page = Math.max(page, 1);

        const messages = await db.client
            .collection('audit.files')
            .find(query)
            .limit(this.pageLimit)
            .skip((page - 1) * this.pageLimit)
            .sort({ 'metadata.date': -1 })
            .toArray();

        messages.forEach(messageData => {
            messageData.display = this.getAuditMessageDisplay(messageData);
        });

        return {
            page,
            pages,
            data: messages
        };
    }
}

module.exports = new Audits();
