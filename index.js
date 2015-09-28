'use strict';
var redis = require('redis'),
  crypto = require('crypto');

module.exports = function createMemoizeFunction(client, options) {
  // Support passing in an existing client. If the first arg is not a client, assume that it is
  // connection parameters.
  if (!(client && client.connectionOption)) {
    client = redis.createClient.apply(null, arguments);
  }

  options = options || {};
  if (options.lookup_timeout === undefined) options.lookup_timeout = 1000; // ms
  if (options.default_ttl === undefined) options.default_ttl = 120000;
  if (options.time_label_prefix === undefined) options.time_label_prefix = '';
  // Set to a function that determines whether or not to memoize an error.
  if (options.memoize_errors_when === undefined) options.memoize_errors_when = function(err) {return true;};

  // Apply key namespace, if present.
  var keyNamespace = 'memos:';

  // Allow custom namespaces, e.g. by git revision.
  if (options.memoize_key_namespace) {
    keyNamespace += options.memoize_key_namespace;
    if (keyNamespace.slice(-1) !== ':') keyNamespace += ':';
  }

  return memoizeFn.bind(null, client, options, keyNamespace);
};

function memoizeFn(client, options, keyNamespace, fn, ttl, timeLabel) {
  // We need to just uniquely identify this function, no way in hell are we going to try
  // to make different memoize calls of the same function actually match up (and save the key).
  // It's too hard to do that considering so many functions can look identical (wrappers, say, of promises)
  // yet be very different. This guid() seems to do the trick.
  var functionKey = hash(fn.toString() + guid()),
    inFlight = {},
    ttlfn;

  if(typeof ttl === 'function') {
    ttlfn = ttl;
  } else {
    ttlfn = function() { return ttl === undefined ? options.default_ttl : ttl; };
  }
  return function memoizedFunction() {
    var self = this;  // if 'this' is used in the function

    var args = new Array(arguments.length);
    for (var i = 0; i < args.length; i++) {
      args[i] = arguments[i];
    }
    var done = args.pop();

    if (typeof done !== 'function') {
      throw new Error('Redis-Memoizer: Last argument to memoized function must be a callback!');
    }

    // Hash the args so we can look for this key in redis.
    var argsHash = hash(JSON.stringify(args));

    // Set a timeout on the retrieval from redis.
    var timeout = setTimeout(function() {
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

      if (err && process.env.NODE_ENV !== 'production') console.error(err);
      // If the value was found in redis, we're done, call back with it.
      if (value) {
        done.apply(self, value);
      }
      // Prevent a cache stampede, queue this result.
      else if (inFlight[argsHash]) {
        inFlight[argsHash].push(done);
      }
      // No other requests in flight, let's call the real function and get the result.
      else {
        // Mark this function as in flight.
        inFlight[argsHash] = [done];

        if (timeLabel) console.time(options.time_label_prefix + timeLabel);

        fn.apply(self, args.concat(function() {
          var resultArgs = new Array(arguments.length);
          for (var i = 0; i < resultArgs.length; i++) {
            resultArgs[i] = arguments[i];
          }
          if (timeLabel) console.timeEnd(options.time_label_prefix + timeLabel);

          // Don't write results that throw a connection error (service interruption);
          if (!(resultArgs[0] instanceof Error) || options.memoize_errors_when(resultArgs[0])) {
            writeKeyToRedis(client, keyNamespace, functionKey, argsHash, resultArgs, ttlfn.apply(null, resultArgs));
          }

          // If the same request was in flight from other sources, resolve them.
          if(inFlight[argsHash]) {
            inFlight[argsHash].forEach(function(cb) {
              cb.apply(self, resultArgs);
            });
            // Rather than use delete set null here so inFlight doesn't become a slow obj.
            // TODO figure out if this leaks enough memory to matter
            inFlight[argsHash] = null;
          }
        }));
      }
    }
  };
}

function guid() {
  function s4() {
    return Math.floor((1 + Math.random()) * 0x10000)
      .toString(16)
      .substring(1);
  }
  return s4() + s4() + '-' + s4() + '-' + s4() + '-' +
    s4() + '-' + s4() + s4() + s4();
}

function hash(string) {
  return crypto.createHmac('sha1', 'memo').update(string).digest('hex');
}

function getKeyFromRedis(client, keyNamespace, ns, key, done) {
  if (!client.connected) {
    return done(new Error('Redis-Memoizer: Not connected.'));
  }
  client.get(keyNamespace + ns + ':' + key, function(err, value) {
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

function writeKeyToRedis(client, keyNamespace, ns, key, value, ttl, done) {
  if (!client.connected) {
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
  client.psetex(keyNamespace + ns + ':' + key, ttl, value, done);
}
