'use strict';

const db = require('./db');
const logger = require('./logger').child('audit');
const UserHandler = require('@zone-eu/wildduck/lib/user-handler');
const AuditHandler = require('@zone-eu/wildduck/lib/audit-handler');
const humanize = require('humanize');
const { ObjectID } = require('mongodb');
const { signCleartext } = require('./tools');

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

    async listAudits(audit, level) {
        if (typeof audit === 'string') {
            audit = new ObjectID(audit);
        }

        const query = {};
        switch (level) {
            case 'group':
                query['meta.group'] = audit;
                break;
            case 'audit':
            default:
                query._id = audit;
                break;
        }

        query.deleted = false;
        query.expires = { $gt: new Date() };

        const audits = await db.client.collection('audits').find(query).sort({ _id: -1 }).toArray();

        audits.forEach(auditData => {
            auditData.display = this.getAuditDisplay(auditData);
        });

        return audits;
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

        data.fromShort = data.from && data.from[0];
        data.toShort = Object.assign({}, (data.to && data.to[0]) || {});
        data.toShort.display = data.toShort.address;
        if (data.to && data.to.length > 1) {
            data.toShort.display += ` +${data.to.length - 1}`;
        }

        return data;
    }

    async listMessages(audit, query, page) {
        //const query = { 'metadata.audit': audit };

        const count = await db.gridfs.collection('audit.files').countDocuments(query);
        const pages = Math.max(Math.ceil(count / this.pageLimit), 1);

        page = Math.min(page || 1, pages);
        page = Math.max(page, 1);

        const messages = await db.gridfs
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

    async listLogs(audit, page) {
        const query = { audit, action: 'fetch_messages', 'metadata.hash': { $exists: true } };

        const count = await db.client.collection('auditstream').countDocuments(query);
        const pages = Math.max(Math.ceil(count / this.pageLimit), 1);

        page = Math.min(page || 1, pages);
        page = Math.max(page, 1);

        const entries = await db.client
            .collection('auditstream')
            .find(query)
            .limit(this.pageLimit)
            .skip((page - 1) * this.pageLimit)
            .sort({ _id: -1 })
            .toArray();

        return {
            page,
            pages,
            data: entries.map(entry => {
                entry.displayTime = entry.metadata.curtime.toISOString();
                entry.displaySize = humanize.filesize(entry.metadata.bytes, 1024, 0, '.', ' ');
                entry.displayMessageCount = humanize.numberFormat(entry.metadata.messageCount, 0, '.', ' ');
                entry.zip = entry.metadata.type === 'query';
                return entry;
            })
        };
    }

    async getSignedLog(audit, entry) {
        const logData = await db.client.collection('auditstream').findOne({ audit, _id: new ObjectID(entry) });
        if (!logData) {
            return false;
        }

        const now = new Date();
        const auditData = await db.client.collection('audits').findOne({ _id: logData.audit, deleted: false, expires: { $gt: now } });
        if (!auditData) {
            return false;
        }

        const groupData = await db.client.collection('auditgroups').findOne({ _id: auditData.meta.group, deleted: false, expires: { $gt: now } });
        if (!groupData) {
            return false;
        }

        const entryTitle = 'Log entry for an email download';

        const cleartext = `${entryTitle}
${'='.repeat(entryTitle.length)}

File name: ${logData.metadata.fileName}
File hash (${logData.metadata.algo}): ${logData.metadata.hash}

Audit: ${groupData.name}
Audit ID: ${groupData._id}/${auditData._id}
Account: ${auditData.meta.name} <${auditData.meta.address}> (${auditData.meta.username})

File size: ${logData.metadata.bytes} bytes
Included emails: ${logData.metadata.messageCount}

Downloader: ${logData.metadata.owner.name} (${logData.metadata.owner.username})
Download time: ${logData.metadata.curtime.toISOString()}`;

        logData.signed = await signCleartext(cleartext, logData.metadata.curtime);

        return logData;
    }

    async getMessage(audit, message) {
        if (typeof audit === 'string') {
            audit = new ObjectID(audit);
        }
        if (typeof message === 'string') {
            message = new ObjectID(message);
        }
        //const query = { 'metadata.audit': audit };

        const messageData = await db.gridfs.collection('audit.files').findOne({
            _id: message,
            'metadata.audit': audit
        });
        if (!messageData) {
            return false;
        }

        messageData.display = this.getAuditMessageDisplay(messageData);

        return messageData;
    }

    async stream(message) {
        if (typeof message === 'string') {
            message = new ObjectID(message);
        }
        return this.auditHandler.retrieve(message);
    }
}

module.exports = new Audits();
