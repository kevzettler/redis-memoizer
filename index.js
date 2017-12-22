'use strict';
const redis = require('redis');
const crypto = require('crypto');
const uuid = require('node-uuid');
const zlib = require('zlib');

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

  if (!client.options.return_buffers) {
    throw new Error("A redis client passed to the memoizer must have the option `return_buffers` set to true.");
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
  let inFlight = {};
  let ttlfn;

  if(typeof ttl === 'function') {
    ttlfn = ttl;
  } else {
    ttlfn = function() { return ttl === undefined ? options.default_ttl : ttl; };
  }
  return function memoizedFunction() {
    const self = this;  // if 'this' is used in the function

    const args = new Array(arguments.length);
    for (let i = 0; i < args.length; i++) {
      args[i] = arguments[i];
    }
    const done = args.pop();

    if (typeof done !== 'function') {
      throw new Error('Redis-Memoizer: Last argument to memoized function must be a callback!');
    }

    // Hash the args so we can look for this key in redis.
    const argsHash = module.exports.hash(args);

    // Set a timeout on the retrieval from redis.
    let timeout = setTimeout(function() {
      onLookup(new Error('Redis-Memoizer: Lookup timeout.'));
    }, Math.min(ttlfn(), options.lookup_timeout));

    // Attempt to get the result from redis.
    getKeyFromRedis(client, keyNamespace, functionKey, argsHash, onLookup);

    function onLookup(err, value) {
      // Don't run twice.
      if (!timeout) return;
      // Clear pending timeout if it hasn't been already, and null it.
      clearTimeout(timeout);
      timeout = null;

      if (err && process.env.NODE_ENV !== 'production') console.error(err.message);
      // If the value was found in redis, we're done, call back with it.
      if (value) {
        return done.apply(self, value);
      }
      // Prevent a cache stampede, queue this result.
      else if (inFlight[argsHash]) {
        return inFlight[argsHash].push(done);
      }
      // No other requests in flight, let's call the real function and get the result.
      else {
        // Mark this function as in flight.
        inFlight[argsHash] = [done];

        if (timeLabel) console.time(options.time_label_prefix + timeLabel);

        fn.apply(self, args.concat(function() {
          const resultArgs = new Array(arguments.length);
          for (let i = 0; i < resultArgs.length; i++) {
            resultArgs[i] = arguments[i];
          }
          if (timeLabel) console.timeEnd(options.time_label_prefix + timeLabel);

          // Don't write results that throw a connection error (service interruption);
          if (!(resultArgs[0] instanceof Error) || options.memoize_errors_when(resultArgs[0])) {
            writeKeyToRedis(client, keyNamespace, functionKey, argsHash, resultArgs, ttlfn.apply(null, resultArgs));
          }

          // If the same request was in flight from other sources, resolve them.
          const fnsInFlight = inFlight[argsHash];
          if(fnsInFlight) {
            for (let i = 0; i < fnsInFlight.length; i++) {
              fnsInFlight[i].apply(self, resultArgs);
            }
            // This is going to be a slow object anyway
            delete inFlight[argsHash];
          }
        }));
      }
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

function isReady(client) {
  // Bail if not connected; don't wait for reconnect, that's probably slower than just computing.
  // 'or' here is for ioredis/node_redis compat
  const connectedNodeRedis = Boolean(client.connected);
  const connectedIORedis = client.status === 'ready';
  return Boolean(connectedNodeRedis || connectedIORedis);
}

function getKeyFromRedis(client, keyNamespace, fnKey, argsHash, done) {
  if (!isReady(client)) {
    return done(new Error('Redis-Memoizer: Not connected.'));
  }
  compressedGet(client, [keyNamespace, fnKey, argsHash].join(':'), function(err, value) {
    if (err) return done(err);

    // Attempt to parse the result. If that fails, return a parse error instead.
    try {
      if (value) value = JSON.parse(value, reviver);
    } catch(e) {
      err = e;
      value = null;
    }
    done(err, value);
  });
}

function writeKeyToRedis(client, keyNamespace, fnKey, argsHash, value, ttl, done) {
  if (!isReady(client)) {
    return done && done(new Error('Redis-Memoizer: Not connected.'));
  }
  // Don't bother writing if ttl is 0.
  if (ttl === 0) {
    return process.nextTick(done || function() {});
  }
  // If the value was an error, we need to do some herky-jerky stringifying.
  if (value[0] instanceof Error) {
    // Mark errors so we can revive them
    value[0].$__memoized_error = true;
    // Seems to do pretty well on errors
    value = JSON.stringify(value, ['message', 'arguments', 'type', 'name', 'stack', '$__memoized_error']);
  } else {
    value = JSON.stringify(value);
  }
  compressedPSetX(client, [keyNamespace, fnKey, argsHash].join(':'), ttl, value, done);
}

function compressedGet(client, key, cb) {
  const get = client.getBuffer || client.get;
  get.call(client, new Buffer(key), function(err, zippedVal) {
    if (err) return cb(err);
    gunzip(zippedVal, function(err, retVal) {
      if (err) return cb(err);
      cb(null, retVal);
    });
  });
}

function compressedPSetX(client, key, ttl, value, cb) {
  gzip(value, function(err, zippedVal) {
    if (err) return cb(err);
    client.psetex(new Buffer(key), ttl, zippedVal, function(err, retVal) {
      if (err && cb) return cb(err);
      cb && cb(null, retVal);
    });
  });
}

function gzip(value, cb) {
  if (value == null) return cb(null, value);
  // Too small to effectively gzip
  if (value.length < 500) return cb(null, value);
  if (process.env.NODE_ENV === 'test') {
    // Race condition otherwise in testing between setting keys and retrieving them
    const zippedVal = zlib.gzipSync(value);
    cb(null, Buffer.concat([GZIP_MAGIC, zippedVal], zippedVal.length + GZIP_MAGIC_LENGTH));
  } else {
    zlib.gzip(value, function(err, zippedVal) {
      if (err) return cb(err);
      cb(null, Buffer.concat([GZIP_MAGIC, zippedVal], zippedVal.length + GZIP_MAGIC_LENGTH));
    });
  }
}

function gunzip(value, cb) {
  // Check for GZIP MAGIC, if there unzip it.
  if (value instanceof Buffer && value.slice(0, GZIP_MAGIC_LENGTH).equals(GZIP_MAGIC)) {
    zlib.gunzip(value.slice(GZIP_MAGIC_LENGTH), cb);
  } else {
    cb(null, value);
  }
}
