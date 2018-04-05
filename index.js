'use strict';
const crypto = require('crypto');
const zlib = require('zlib');
const util = require('util');
const makeLockFn = require('./lock');
const Promise = require('bluebird');
const {clientTyp, exec, isReady} = require('./redisCompat');

const GZIP_MAGIC = new Buffer('$gzip__');
const MAGIC = {
  gzip: GZIP_MAGIC,
  gzip_length: GZIP_MAGIC.length,
  undefined: '_$$_undefined',
  null: '_$$_null',
  notFound: '_$$_empty',
  error: '_$$_error',
  // Used for serializing errors
  error_keys: ['message', 'type', 'name', 'stack'],
};
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
  // Error logger, arity is (err, client, key)
  on_error: null // *must* be implemented
};

module.exports = function createMemoizeFunction(client, options = {}) {
  const typ = clientTyp(client);
  options = Object.assign({}, defaultOptions, options);

  // Allow custom namespaces, e.g. by git revision.
  options.keyNamespace = `memos${options.memoize_key_namespace ? ':' + options.memoize_key_namespace : ''}`;
  const lock = makeLockFn(client, options.lock_retry_delay);

  // Validation
  try {
    if (!typ) {
      throw new Error('Pass a Redis client as the first argument.');
    } else if (typ === 'node_redis') {
      if (!client.getAsync) {
        throw new Error('Node_Redis clients must be promisified. Please use Bluebird to do this.');
      }
      if (!client.options.return_buffers) {
        throw new Error('A Node_Redis client passed to the memoizer must have the option `return_buffers` set to true.');
      }
    }

    if (options.error_logging) {
      throw new Error('The "error_logging" var has been replaced with a more standard ' +
        '"on_error(err, client, key) callback." in 4.0');
    }
    if (typeof options.on_error !== 'function') {
      throw new Error('An error fn of the arity (err, client, key) must be passed as an option.');
    }
  } catch (e) {
    e.message = `Redis-Memoizer: ${e.message}`;
    throw e;
  }

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

module.exports.MAGIC = MAGIC;

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
    if (memoValue !== MAGIC.notFound) return memoValue;

    // Ok, we're going to have to actually execute the function.
    // Lock ensures only one fn executes at a time and prevents a stampede.
    const unlock = await lock(key, lock_timeout);
    let didOriginalFn = false;
    try {
      // After we've acquired the lock, check if the key was populated in the meantime.
      const memoValueRetry = await doLookup(client, key, timeoutMs, options);
      if (memoValueRetry !== MAGIC.notFound) return memoValueRetry;

      // Run the fn, save the result
      didOriginalFn = true;
      const result = await fn.apply(this, args);
      // Write the key, but don't await on it
      writeKeyToRedis(client, key, result, ttlfn(result)).catch((err) => {
        err.message = `Redis-Memoizer: Error writing key "${key}": ${err.message}`;
        options.on_error(err, client, key);
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
    err.message = `Redis-Memoizer: Error getting key "${key}" with timeout ${timeout}: ${err.message}`;
    if (err.name !== 'TimeoutError') {
      options.on_error(err, client, key);
    }
    // Continue on
    return MAGIC.notFound;
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
  else if (value && value.hasOwnProperty(MAGIC.error)) {
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
  if (!isReady(client)) throw new Error('Not connected.');

  let value = await compressedGet(client, key);

  // Coerce back
  if (value instanceof Buffer) value = value.toString(); // redis/ioredis compat
  if (value == null) return MAGIC.notFound;
  else if (value === MAGIC.undefined) return undefined;
  else if (value === MAGIC.null) return null;
  else if (value === '') return value;
  else return JSON.parse(value, reviver);
}

async function writeKeyToRedis(client, key, value, ttl) {
  if (!isReady(client)) throw new Error('Not connected.');

  // Don't bother writing if ttl is 0.
  if (ttl === 0) return;

  // Convert a couple of placeholder values so we can distinguish between a value that is null/undefined,
  // and the key not found.
  let serializedValue;
  if (value === undefined) {
    serializedValue = MAGIC.undefined;
  } else if (value === null) {
    serializedValue = MAGIC.null;
  } else if (value instanceof Error) {
    // Mark errors so we can revive them
    value[MAGIC.error] = true;
    // Seems to do pretty well on errors
    serializedValue = JSON.stringify(value, MAGIC.error_keys.concat([MAGIC.error]));
  } else {
    serializedValue = JSON.stringify(value);
  }

  return compressedPSetX(client, key, ttl, serializedValue);
}

//
// GZIP
//

const gzipAsync = util.promisify(zlib.gzip);
const gunzipAsync = util.promisify(zlib.gunzip);

async function compressedGet(client, key, cb) {
  let zippedVal;
  // Have to use 'getBuffer' for ioredis
  if (clientTyp(client) === 'ioredis') zippedVal = await client.getBuffer(key);
  else zippedVal = await client.getAsync(key);
  return module.exports.gunzip(zippedVal);
}

async function compressedPSetX(client, key, ttl, value) {
  const zippedVal = await module.exports.gzip(value);
  return exec(client, 'set', key, zippedVal, 'PX', ttl);
}

async function gzip(value) {
  // null or too small to effectively gzip
  if (value == null || value.length < 500) return value;

  const zippedVal = await gzipAsync(value);
  return Buffer.concat([MAGIC.gzip, zippedVal], zippedVal.length + MAGIC.gzip_length);
}

async function gunzip(value) {
  // Check for GZIP MAGIC, if there unzip it.
  if (value instanceof Buffer && value.slice(0, MAGIC.gzip_length).equals(MAGIC.gzip)) {
    return gunzipAsync(value.slice(MAGIC.gzip_length));
  } else {
    return value;
  }
}
module.exports.gzip = gzip;
module.exports.gunzip = gunzip;
