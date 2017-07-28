'use strict';
const crypto = require('crypto');
const should = require('should');
const redisOptions = {return_buffers: true};
const redis = require('fakeredis').createClient(redisOptions);
// Compat fix w/fakeredis
redis.options = redisOptions;
const key_namespace = Date.now();
const memoizePkg = require('../');
const memoize = memoizePkg(redis, {memoize_key_namespace: key_namespace});
memoizePkg.uuid = function(fn) {
	return memoizePkg.hash(fn.toString());
};

/*global describe:true, it:true */
describe('redis-memoizer', function() {
	function hash(string) {
		return crypto.createHash('sha1').update(string).digest('hex');
	}

	function clearCache(fn, args, done) {
		const stringified = JSON.stringify(args);
		redis.del(['memos', key_namespace, memoizePkg.uuid(fn), hash(stringified)].join(':'), done);
	}

	it('should memoize a value correctly', function(done) {
		const functionToMemoize = function (val1, val2, done) {
				setTimeout(function() { done(val1, val2); }, 500);
			},
			memoized = memoize(functionToMemoize);

		const start1 = Date.now();
		memoized(1, 2, function(val1, val2) {
			val1.should.equal(1);
			val2.should.equal(2);
			(Date.now() - start1 >= 500).should.be.true;		// First call should go to the function itself

			const start2 = Date.now();
			memoized(1, 2, function(val1, val2) {
				val1.should.equal(1);
				val2.should.equal(2);
				(Date.now() - start2 < 500).should.be.true;		// Second call should be faster

				clearCache(functionToMemoize, [1, 2], done);
			});
		});
	});

	it("should memoize separate function separately", function(done) {
		const function1 = function(arg, done) { setTimeout(function() { done(1); }, 0); },
			function2 = function(arg, done) { setTimeout(function() { done(2); }, 0); };

		const memoizedFn1 = memoize(function1),
			memoizedFn2 = memoize(function2);

		memoizedFn1("x", function(val) {
			val.should.equal(1);

			memoizedFn2("y", function(val) {
				val.should.equal(2);

				memoizedFn1("x", function(val) {
					val.should.equal(1);

					clearCache(function1, ["x"]);
					clearCache(function2, ["y"], done);
				});
			});
		});
	});

	it("should prevent a cache stampede", function(done) {
		const fn = function(done) { setTimeout(done, 500); },
			memoized = memoize(fn);

		let start = Date.now();

		memoized(function() {
			// First one. Should take 500ms
			(Date.now() - start >= 500).should.be.true;

			start = Date.now();	// Set current time for next callback;
		});

		memoized(function() {
			(Date.now() - start <= 10).should.be.true;
			clearCache(fn, [], done);
		});
	});

	it('should respect \'this\'', function(done) {
		function Obj() { this.x = 1; }
		Obj.prototype.y = memoize(function(done) {
			const self = this;

			setTimeout(function() {
				done(self.x);
			}, 300);
		});

		const obj = new Obj();

		obj.y(function(x) {
			x.should.equal(1);
			clearCache(obj.y, [], done);
		});
	});

	it('should respect the ttl', function(done) {
		let hits = 0;
		const fn = function respectTTL(done) { hits++; done(); },
			memoized = memoize(fn, 100);

		memoized(function() {
			hits.should.equal(1);

			// Call within ttl again. Should be a cache hit
			setTimeout(function() {
				memoized(function() {
					hits.should.equal(1);

					// Wait some time, ttl should have expired
					setTimeout(function() {
						memoized(function() {
							hits.should.equal(2);
							clearCache(fn, [], done);
						});
					}, 60);
				});
			}, 50);
		});
	});

	it('should allow ttl to be a function', function(done) {
		let hits = 0;
		const fn = function ttlFunction(done) { hits++; done(); },
			memoized = memoize(fn, function() { return 100; });

		memoized(function(err, result) {
			hits.should.equal(1);

			// Call within ttl again. Should be a cache hit
			setTimeout(function() {
				memoized(function() {
					hits.should.equal(1);

					// Wait some time, ttl should have expired
					setTimeout(function() {
						memoized(function() {
							hits.should.equal(2);
							clearCache(fn, [], done);
						});
					}, 60);
				});
			}, 50);
		});
	});

	it('should give up after lookup_timeout', function(done) {
		// Override redis.get to introduce a delay.
		const get = redis.get;
		redis.get = function(key, cb) {
			setTimeout(cb, 500);
		};

		let callCounter = 0;
		const memoize = require('../')(redis, {lookup_timeout: 20});
		const fn = function(done) { callCounter++; done(null, 1); },
			memoized = memoize(fn, 1000);

		let start = Date.now();

		// Call. Should call before redis responds.
		memoized(function() {
			(Date.now() - start <= 500).should.be.true;
			callCounter.should.equal(1);

			// Call immediately again. Should not hit cache.
			start = Date.now();
			memoized(function() {
				(Date.now() - start <= 500).should.be.true;
				callCounter.should.equal(2);

				// Restore redis.get
				redis.get = get;
				clearCache(fn, [], done);
			});
		});
	});

	it('should work if complex types are accepted as args and returned', function(done) {
		const fn = function(arg1, done) {
			setTimeout(function() {
				done(arg1, ["other", "data"]);
			}, 500);
		};

		const memoized = memoize(fn);

		let start = Date.now();
		memoized({some: "data"}, function(val1, val2) {
			(Date.now() - start >= 500).should.be.true;
			val1.should.eql({some: "data"});
			val2.should.eql(["other", "data"]);

			start = Date.now();
			memoized({some: "data"}, function(val1, val2) {
				(Date.now() - start <= 100).should.be.true;
				val1.should.eql({some: "data"});
				val2.should.eql(["other", "data"]);

				clearCache(fn, [{some: "data"}], done);
			});
		});
	});

	it('should restore Date objects, not strings', function(done) {
		const date1 = new Date("2000-01-01T00:00:00.000Z");
		const date2 = new Date("2000-01-02T00:00:00.000Z");

		const fn = function(arg1, done) {
			setTimeout(function() {
				done(arg1, date2);
			}, 500);
		};
		const memoized = memoize(fn);

		let start = Date.now();
		memoized(date1, function(val1, val2) {
			(Date.now() - start >= 500).should.be.true;
			val1.should.be.an.instanceOf(Date);
			val2.should.be.an.instanceOf(Date);
			val1.should.eql(date1);
			val2.should.eql(date2);

			start = Date.now();
			memoized(date1, function(val1, val2) {
				(Date.now() - start <= 100).should.be.true;
				val1.should.be.an.instanceOf(Date);
				val2.should.be.an.instanceOf(Date);
				val1.should.eql(date1);
				val2.should.eql(date2);

				clearCache(fn, [date1], done);
			});
		});
	});

	it('should error when not fed a callback', function(done) {
		const fn = function(arg1, done) {
			setTimeout(function() {
				done(null, arg1);
			}, 0);
		};

		const memoized = memoize(fn);

		try {
			memoized('foo');
		} catch(e) {
			e.should.be.an.instanceOf(Error);
			done();
		}
	});

	it('should memoize errors', function(done) {
		let hits = 0;
		const fn = function errorFunction(done) {
			hits++;
			if (hits === 1) done(new Error('Hit Error!'));
			else done();
		};

		const memoized = memoize(fn, 1000);
		memoized(function(e) {
			e.should.be.an.instanceOf(Error);
			e.message.should.eql('Hit Error!');
			memoized(function(e) {
				e.should.be.an.instanceOf(Error);
				e.message.should.eql('Hit Error!');
				done();
			});
		});
	});

	it('should not memoize errors that are filtered out', function(done) {
		let hits = 0;
		const fn = function errorFunction(done) {
			hits++;
			if (hits === 1) done(new Error('Hit Error!'));
			else if (hits === 2) done(new Error('Special Error!'));
			else done(null, hits);
		};

		const do_memoize = require('../')(redis, {
			memoize_key_namespace: Date.now(),
			memoize_errors_when: function(err) {
				return err.message !== 'Hit Error!';
			}
		});

		// First error won't be memoized, so expect hits to increment on subsequent calls.
		// Second error will, so hits will freeze there.
		const memoized = do_memoize(fn, 1000);
		memoized(function(e) {
			e.should.be.an.instanceOf(Error);
			e.message.should.eql('Hit Error!');
			hits.should.eql(1);
			memoized(function(e, result) {
				should.not.exist(result);
				e.should.be.an.instanceOf(Error);
				e.message.should.eql('Special Error!');
				hits.should.eql(2);
				memoized(function(e, result) {
					should.not.exist(result);
					e.should.be.an.instanceOf(Error);
					e.message.should.eql('Special Error!');
					hits.should.eql(2);
					done();
				});
			});
		});
	});

	it('should not memoize two identical-looking functions to the same key', function(done) {
		const funcA = (function() {
			const a = 10;
			return function(cb) {
				return cb(a);
			};
		})();
		const funcB = (function() {
			const a = 20;
			return function(cb) {
				return cb(a);
			};
		})();

		const memoizedA = memoize(funcA);
		const memoizedB = memoize(funcB);
		memoizedA(function(result) {
			result.should.eql(10);
			memoizedB(function(result2) {
				result2.should.eql(20);
				done();
			});
		});
	});
});
