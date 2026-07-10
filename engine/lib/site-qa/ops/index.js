'use strict';
// ops — public entry for operational tooling: configuration + tamper-evident backup/restore/verify
// for the append-only stores. Additive; touches no frozen file. Backups exploit the stores'
// immutability (a byte-copy is a true, verifiable snapshot).
const { DEFAULTS, loadConfig } = require('./config');
const { backup, verifyBackup, restore, listFiles, sha256File } = require('./backup');

const OPS_VERSION = '1.0.0';

module.exports = { OPS_VERSION, DEFAULTS, loadConfig, backup, verifyBackup, restore, listFiles, sha256File };
