'use strict';

const config = require('wild-config');
const mongodb = require('mongodb');
const Redis = require('ioredis');

const { MongoClient } = mongodb;

module.exports = {
    async connect() {
        const mongoClient = await MongoClient.connect(config.dbs.mongo, {
            useNewUrlParser: true,
            useUnifiedTopology: true
        });

        module.exports.connection = mongoClient;
        module.exports.client = mongoClient.db();
        module.exports.redis = new Redis(config.dbs.redis);

        module.exports.users = config.dbs.users ? mongoClient.db(config.dbs.users) : module.exports.client;
        module.exports.gridfs = config.dbs.gridfs ? mongoClient.db(config.dbs.gridfs) : module.exports.client;
    }
};
