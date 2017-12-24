'use strict';
const crypto = require('crypto');
const zlib = require('zlib');
const util = require('util');
const makeLockFn = require('./lock');
const Promise = require('bluebird');

const GZIP_MAGIC = new Buffer('$gzip__');
const GZIP_MAGIC_LENGTH = GZIP_MAGIC.length;
const undefinedMarker = '_$$_undefined';
const nullMarker = '_$$_null';
const internalNotFoundInRedis = '_$$_empty';
const errorMarkerKey = '_$$_error';
const defaultOptions = {
  // Properties prefixed with `default_` can be overridden when creating each memoized function.
  // How long to persist memoized results to Redis. This can be overridden per-fn.
  default_ttl: 120000,
  // How long to wait for the lock (including retries)
  default_lock_timeout: 5000,

  // How long to wait on Redis before just moving on.
  // If the TTL fed to `memoize` is shorter than this, it will be used instead.
  lookup_timeout: 1000, // ms
  // Set to a function that determines whether or not to memoize an error. By default, we never do.
  memoize_errors_when: (err) => false,
  // Namespace to use under `memos:` in redis. Useful to e.g. invalidate all cache after
  // an application update; simply set this to the current git revision or use the boot timestamp.
  memoize_key_namespace: null,
  // How often to spin on the lock
  lock_retry_delay: 50,
  error_logging: process.env.NODE_ENV !== 'production',
};

module.exports = function createMemoizeFunction(client, options = {}) {
  // NOTE: This only supports ioredis right now
  if (!client || !(client.constructor && (client.constructor.name === 'RedisClient' || client.constructor.name === 'Redis'))) {
    throw new Error('Pass a Redis client as the first argument.');
  }
  options = Object.assign({}, defaultOptions, options);

  // Allow custom namespaces, e.g. by git revision.
  options.keyNamespace = `memos${options.memoize_key_namespace ? ':' + options.memoize_key_namespace : ''}`;
  const lock = makeLockFn(client, options.lock_retry_delay);

  return memoizeFn.bind(null, client, options, lock);
};

// Exported so it can be overridden
module.exports.getFunctionKey = function(fn, name = fn._name) {
  if (!name) throw new Error("Unable to determine memoization name for function: " + fn);
  return name;
};

module.exports.hash = function(args) {
  return crypto.createHash('sha1').update(JSON.stringify(args)).digest('hex');
};

function memoizeFn(client, options, lock, fn,
                   {ttl = options.default_ttl, lock_timeout = options.default_lock_timeout, name} = {}) {
  let functionKey = module.exports.getFunctionKey(fn, name);
  const ttlfn = typeof ttl === 'function' ? ttl : () => ttl;

  return async function memoizedFunction(...args) {
    // Hash the args so we can look for this key in redis.
    const argsHash = module.exports.hash(args);

    // Set a timeout on the retrieval from redis.
    const timeoutMs = Math.min(ttlfn(), options.lookup_timeout);
    const key = `${options.keyNamespace}:${functionKey}:${argsHash}`;

    // Attempt to get the result from redis.
    const memoValue = await doLookup(client, key, timeoutMs, options);
    // We return an internal marker if this thing was actually not found, versus just null
    if (memoValue !== internalNotFoundInRedis) return memoValue;

    // Ok, we're going to have to actually execute the function.
    // Lock ensures only one fn executes at a time and prevents a stampede.
    const unlock = await lock(key, lock_timeout);
    let didOriginalFn = false;
    try {
      // After we've acquired the lock, check if the key was populated in the meantime.
      const memoValueRetry = await doLookup(client, key, timeoutMs, options);
      if (memoValueRetry !== internalNotFoundInRedis) return memoValueRetry;

      // Run the fn, save the result
      didOriginalFn = true;
      const result = await fn.apply(this, args);
      // Write the key, but don't await on it
      writeKeyToRedis(client, key, result, ttlfn(result)).catch((err) => {
        if (options.error_logging) console.error(err.message);
      });

      return result;
    } catch (e) {
      // original function errored, should we memoize that?
      if (didOriginalFn && options.memoize_errors_when(e)) {
        await writeKeyToRedis(client, key, e, ttlfn(e));
      }
      throw e;
    } finally {
      unlock();
    }
  };
}

async function doLookup(client, key, timeout, options) {
  let memoValue;
  try {
    memoValue = await Promise.resolve(getKeyFromRedis(client, key)).timeout(timeout);
  } catch (err) {
    // Continue on
    if (options.error_logging) console.error(err.message);
  }

  if (memoValue instanceof Error) throw memoValue; // we memoized an error.
  return memoValue;
}

// Used as filter function in JSON.parse so it properly restores dates
var reISO = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2}(?:\.\d*))(?:Z|(\+|-)([\d|:]*))?$/;
function reviver(key, value) {
  // Revive dates
  if (typeof value === 'string' && reISO.exec(value)) {
    return new Date(value);
  }
  // Revive errors
  else if (value && value.hasOwnProperty(errorMarkerKey)) {
    var err = new Error(value.message);
    err.stack = value.stack;
    err.name = value.name;
    err.type = value.type;
    err.arguments = value.arguments;
    return err;
  }
  return value;
}

async function getKeyFromRedis(client, key) {
  // Bail if not connected; don't wait for reconnect, that's probably slower than just computing.
  if (!isReady(client)) throw new Error('Redis-Memoizer: Not connected.');

  let value = await compressedGet(client, key);

  // Coerce back
  if (value instanceof Buffer) value = value.toString(); // redis/ioredis compat
  if (value === null) return internalNotFoundInRedis;
  else if (value === undefinedMarker) return undefined;
  else if (value === nullMarker) return null;
  else if (value === '') return value;
  else return JSON.parse(value, reviver);
}

async function writeKeyToRedis(client, key, value, ttl) {
  if (!isReady(client)) throw new Error('Redis-Memoizer: Not connected.');

  // Don't bother writing if ttl is 0.
  if (ttl === 0) return;

  // Convert a couple of placeholder values so we can distinguish between a value that is null/undefined,
  // and the key not found.
  let serializedValue;
  if (value === undefined) {
    serializedValue = undefinedMarker;
  } else if (value === null) {
    serializedValue = nullMarker;
  } else if (value instanceof Error) {
    // Mark errors so we can revive them
    value[errorMarkerKey] = true;
    // Seems to do pretty well on errors
    serializedValue = JSON.stringify(value, ['message', 'arguments', 'type', 'name', 'stack', errorMarkerKey]);
  } else {
    serializedValue = JSON.stringify(value);
  }

  return compressedPSetX(client, key, ttl, serializedValue);
}

// NOTE: This only supports ioredis
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
