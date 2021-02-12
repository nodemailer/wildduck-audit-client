# WildDuck Audit Client

WildDuck Audit system allows to debug email accounts in a [WildDuck email server](https://wildduck.email/). When auditing is enabled for an email account then all messages that match the given timeframe are copied to the auditing system for inspection. Once the audit reaches its expiration date all data related to the audit is deleted from the system.

## Features

-   Can access audit data until the expiration date of the audit. Access must be granted by an admin user in [WildDuck Audit Manager](https://github.com/nodemailer/wildduck-audit-manager)
-   Can search emails based on message meta data
-   Can see email meta data in the web UI
-   Can download original email file
-   Can download emails in bulk
-   Logs user activities

## Usage

```
$ npm install --production
$ npm start
```

### Configuration

Configuration resides in [config/default.toml](config/default.toml). For better manageability you can create a separate config file for server specific options that is then merged with default config options.

**Example systemd unit file**

This service definition merges configuration options from /path/to/audit-manager.toml with default.toml

```
[Service]
Environment="NODE_CONFIG_PATH=/path/to/audit-client.toml"
Environment="NODE_ENV=production"
WorkingDirectory=/path/to/wildduck-audit-client
ExecStart=/usr/bin/npm start
```

### Access

Access to the WildDuck Audit Client can be granted in [WildDuck Audit Manager](https://github.com/nodemailer/wildduck-audit-manager). Audit client itself has no capabilities of managing access.

### Considerations

-   Only allow access from trusted IP addresses, this application should not be available for public access

## License

WildDuck Audit Manager is licensed under the [European Union Public License 1.2](LICENSE) or later.
