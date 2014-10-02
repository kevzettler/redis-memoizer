'use strict';
var redis = require('redis'),
  RedisClient = redis.RedisClient,
	crypto = require('crypto'),
	util = require('util');

module.exports = function(client) {
	// Support passing in an existing client. If the first arg is not a client, assume that it is
	// connection parameters.
	if (!(client && client.connectionOption)) {
	  client = redis.createClient.apply(null, arguments);
	}
	
	// Apply key namespace, if present.
	var options = arguments[arguments.length - 1];
	var keyNamespace = 'memos:';

	// Allow custom namespaces, e.g. by git revision.
	if (Object.prototype.toString.call(options) === '[object Object]' && options.memoize_key_namespace) {
		keyNamespace += options.memoize_key_namespace;
		if (keyNamespace.slice(-1) !== ':') keyNamespace += ':';
	}

	function hash(string) {
		return crypto.createHmac('sha1', 'memo').update(string).digest('hex');
	}

	function getKeyFromRedis(ns, key, done) {
		if (!client.connected) {
			return done(new Error("Not connected."));
		}
		client.get(keyNamespace + ns + ':' + key, function(err, value) {
			done(err, value && JSON.parse(value));
		});
	}

	function writeKeyToRedis(ns, key, value, ttl, done) {
		if (!client.connected) {
			return done && done(new Error("Not connected."));
		}
		if (ttl === 0) {
			return process.nextTick(done || function() {});
		}
		if (value[0] instanceof Error) {
			// Use slower util.inspect() for errors, they have circular references which util.inspect()
			// can fix but JSON.stringify barfs on
			value = util.inspect(value);
		} else {
			value = JSON.stringify(value);
		}
		client.setex(keyNamespace + ns + ':' + key, ttl, value, done);
	}

	return function memoize(fn, ttl) {
		var functionKey = hash(fn.toString()),
			inFlight = {},
			ttlfn;

		if(typeof ttl == 'function') {
			ttlfn = ttl;
		} else {
			ttlfn = function() { return ttl || 120; };
		}

		return function memoizedFunction() {
			var self = this,	// if 'this' is used in the function
				args = Array.prototype.slice.call(arguments),
				done = args.pop(),
				argsStringified = args.map(function(arg) { return JSON.stringify(arg); }).join(",");

			argsStringified = hash(argsStringified);

			getKeyFromRedis(functionKey, argsStringified, function(err, value) {
				if(value) {
					done.apply(self, value);
				} else if(inFlight[argsStringified]) {
					inFlight[argsStringified].push(done);
				} else {
					inFlight[argsStringified] = [done];

					fn.apply(self, args.concat(function() {
						var resultArgs = Array.prototype.slice.call(arguments);

						// Don't write results that throw a connection error (service interruption);
						if (!(resultArgs[0] instanceof Error && /ECONNREFUSED/.test(resultArgs[0].message))) {
							writeKeyToRedis(functionKey, argsStringified, resultArgs, ttlfn.apply(null, resultArgs));
						} 

						if(inFlight[argsStringified]) {
							inFlight[argsStringified].forEach(function(cb) {
								cb.apply(self, resultArgs);
							});
							delete inFlight[argsStringified];
						}
					}));
				}
			});
		};
	};
};
