'use strict';
const redis = require('ioredis');
const crypto = require('crypto');
const uuid = require('node-uuid');
const zlib = require('zlib');
const util = require('util');
const Promise = require('bluebird');

const GZIP_MAGIC = new Buffer('$gzip__');
const GZIP_MAGIC_LENGTH = GZIP_MAGIC.length;

module.exports = function createMemoizeFunction(client, options) {
  options = options || {};
  options.return_buffers = true;
  // Support passing in an existing client. If the first arg is not a client, assume that it is
  // connection parameters.
  if (!client || !(client.constructor && (client.constructor.name === 'RedisClient' || client.constructor.name === 'Redis'))) {
    client = redis.createClient.apply(redis, arguments);
  }

  if (options.lookup_timeout === undefined) options.lookup_timeout = 1000; // ms
  if (options.default_ttl === undefined) options.default_ttl = 120000;
  if (options.time_label_prefix === undefined) options.time_label_prefix = '';
  // Set to a function that determines whether or not to memoize an error.
  if (options.memoize_errors_when === undefined) options.memoize_errors_when = function(err) {return true;};

  // Apply key namespace, if present.
  let keyNamespace = 'memos';

  // Allow custom namespaces, e.g. by git revision.
  if (options.memoize_key_namespace) {
    keyNamespace += ':' + options.memoize_key_namespace;
  }

  return memoizeFn.bind(null, client, options, keyNamespace);
};

// Exported so it can be overridden
module.exports.uuid = function() {
  return uuid.v4();
};

module.exports.hash = function(args) {
  return crypto.createHash('sha1').update(JSON.stringify(args)).digest('hex');
};

function memoizeFn(client, options, keyNamespace, fn, ttl, timeLabel) {
  // We need to just uniquely identify this function, no way in hell are we going to try
  // to make different memoize calls of the same function actually match up (and save the key).
  // It's too hard to do that considering so many functions can look identical (wrappers, say, of promises)
  // yet be very different. This guid() seems to do the trick.
  let functionKey = module.exports.uuid(fn);
  let ttlfn;

  if(typeof ttl === 'function') {
    ttlfn = ttl;
  } else {
    if (!ttl) ttl = options.default_ttl;
    ttlfn = () => ttl;
  }

  return async function memoizedFunction(...args) {
    // Hash the args so we can look for this key in redis.
    const argsHash = module.exports.hash(args);
    const write = (result) => writeKeyToRedis(client, keyNamespace, functionKey, argsHash, result, ttlfn(result));

    // Set a timeout on the retrieval from redis.
    const timeoutMs = Math.min(ttlfn(), options.lookup_timeout);

    // Attempt to get the result from redis.
    let memoValue;
    try {
      memoValue = await Promise.resolve(getKeyFromRedis(client, keyNamespace, functionKey, argsHash))
        .timeout(timeoutMs);
      // Note this may be an error, but that
    } catch (err) {
      // Continue on
      if (process.env.NODE_ENV !== 'production') console.error(err.message);
    }

    if (memoValue instanceof Error) throw memoValue; // we memoized an error.
    if (memoValue != null) return memoValue; // we memoized something we want to return;

    try {
      // TODO lock; first attempt to get directly, if empty, then get lock and try again, only then do we run fn
      if (timeLabel) console.time(options.time_label_prefix + timeLabel);
      // Run the fn, save the result
      const result = await fn.apply(this, args);
      if (typeof result === Error) throw result;
      await write(result);
      return result;
    } catch (e) {
      // original function errored, should we memoize that?
      if (options.memoize_errors_when(e)) await write(e);
      throw e;
    } finally {
      if (timeLabel) console.timeEnd(options.time_label_prefix + timeLabel);
    }
  };
}

// Used as filter function in JSON.parse so it properly restores dates
var reISO = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2}(?:\.\d*))(?:Z|(\+|-)([\d|:]*))?$/;
function reviver (key, value) {
  // Revive dates
  if (typeof value === 'string' && reISO.exec(value)) {
    return new Date(value);
  }
  // Revive errors
  else if (value && value.$__memoized_error) {
    var err = new Error(value.message);
    err.stack = value.stack;
    err.name = value.name;
    err.type = value.type;
    err.arguments = value.arguments;
    return err;
  }
  return value;
}

async function getKeyFromRedis(client, keyNamespace, fnKey, argsHash) {
  // Bail if not connected; don't wait for reconnect, that's probably slower than just computing.
  if (!isReady(client)) throw new Error('Redis-Memoizer: Not connected.');
  let value = await compressedGet(client, [keyNamespace, fnKey, argsHash].join(':'));
  if (value instanceof Buffer) value = value.toString();
  if (value == null || value === '') return value;
  return JSON.parse(value, reviver);
}

async function writeKeyToRedis(client, keyNamespace, fnKey, argsHash, value, ttl) {
  if (!isReady(client)) throw new Error('Redis-Memoizer: Not connected.');
  // Don't bother writing if ttl is 0.
  if (ttl === 0) return;

  // If the value was an error, we need to do some herky-jerky stringifying.
  if (value instanceof Error) {
    // Mark errors so we can revive them
    value.$__memoized_error = true;
    // Seems to do pretty well on errors
    value = JSON.stringify(value, ['message', 'arguments', 'type', 'name', 'stack', '$__memoized_error']);
  } else {
    value = JSON.stringify(value);
  }
  return compressedPSetX(client, [keyNamespace, fnKey, argsHash].join(':'), ttl, value);
}

function isReady(client) {
  return client.status === 'ready';
}

//
// GZIP
//

const gzipAsync = util.promisify(zlib.gzip);
const gunzipAsync = util.promisify(zlib.gunzip);

async function compressedGet(client, key, cb) {
  const zippedVal = await client.getBuffer(key);
  return gunzip(zippedVal);
}

async function compressedPSetX(client, key, ttl, value) {
  const zippedVal = await gzip(value);
  return client.psetex(key, ttl, zippedVal);
}

async function gzip(value) {
  // null or too small to effectively gzip
  if (value == null || value.length < 500) return value;

  const zippedVal = await gzipAsync(value);
  return Buffer.concat([GZIP_MAGIC, zippedVal], zippedVal.length + GZIP_MAGIC_LENGTH);
}

async function gunzip(value, cb) {
  // Check for GZIP MAGIC, if there unzip it.
  if (value instanceof Buffer && value.slice(0, GZIP_MAGIC_LENGTH).equals(GZIP_MAGIC)) {
    return gunzipAsync(value.slice(GZIP_MAGIC_LENGTH));
  } else {
    return value;
  }
}
