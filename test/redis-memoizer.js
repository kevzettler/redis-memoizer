const EventEmitter = require('events');
const crypto = require('crypto');
const should = require('should');
const sinon = require('sinon');
const Promise = require('bluebird');

const memoizePkg = require('../');
const pkgJSON = JSON.stringify(require('../package.json'));
const {exec} = require('../redisCompat');
const PORT = parseInt(process.env.PORT) || 6379;
const PASS = process.env.PASS;

const hash = (string) => crypto.createHmac('sha1', 'memo').update(string).digest('hex');
const key_namespace = Date.now();
const TYPS = {
  ioredis: 'ioredis',
  node_redis: 'redis',
  fakeredis: 'fakeredis',
};

const emitter = new EventEmitter();
sinon.stub(emitter, 'emit');

async function delKeys(client, keyPattern) {
  const keys = await exec(client, 'keys', keyPattern);
  return await Promise.map(keys, (key) => exec(client, 'del', key.toString()));
}

function makeDefaultOptions() {
  return {
    memoize_key_namespace: key_namespace,
    on_error: (err) => { throw err; },
    emitter: emitter
  };
}


describe('redis-memoizer', () => {

  beforeEach(() => {
    emitter.emit.reset();
  });

  const REDIS_TYP = TYPS[process.env.REDIS_TYP] || 'ioredis';
  const Redis = require(REDIS_TYP);
  if (REDIS_TYP !== 'ioredis') {
    Promise.promisifyAll(Redis.RedisClient.prototype);
    Promise.promisifyAll(Redis.Multi.prototype);
  }

  const clientOptions = { return_buffers: true };
  if(PASS) clientOptions.password = PASS;

  const client = Redis.createClient(PORT, 'localhost', clientOptions);
  if (REDIS_TYP === 'fakeredis') client.options.return_buffers = true; // workaround check, it sets opts badly

  let memoize = memoizePkg(client, {
    ...makeDefaultOptions(),
  });

  const originalMemoize = memoize;
  // Record the name so we can clear this out
  memoize = function(fn, options) {
    // Ensures we can't clobber our own names
    fn._name = String(Math.random()) + memoizePkg.getFunctionKey(fn, options);
    return originalMemoize.apply(this, arguments);
  };

  // Wait for connection
  before(async () => {
    if (REDIS_TYP === 'ioredis' && client.status !== 'connect') {
      return new Promise((resolve) => client.on('connect', resolve));
    }
  });

	afterEach(async () => {
    await delKeys(client, `memos:${key_namespace}:*`);
  });

  after(() => {
		client.end(true);
  });

  it('should memoize a value correctly', async () => {
    const functionDelayTime = 10;
    let callCount = 0;
    const functionToMemoize = async (val1, val2) => {
      callCount++;
      await Promise.delay(functionDelayTime);
      return { val1, val2 };
    };
    const memoized = memoize(functionToMemoize, {name: 'fn1'});

    let start = Date.now();
    let { val1, val2 } = await memoized(1, 2);
    val1.should.equal(1);
    val2.should.equal(2);
    (Date.now() - start >= functionDelayTime).should.be.true;		// First call should go to the function itself
    callCount.should.equal(1);

    should(emitter.emit.thirdCall.args).eql(['miss', 'fn1']);

    start = Date.now();
    ({ val1, val2 } = await memoized(1, 2));
    val1.should.equal(1);
    val2.should.equal(2);
    (Date.now() - start < functionDelayTime).should.be.true;		// Second call should be faster
    callCount.should.equal(1);

    should(emitter.emit.lastCall.args).eql(['hit', 'fn1']);

    should(emitter.emit.calledWith('lookup', 'fn1')).be.true();
    should(emitter.emit.calledWith('unlock', 'fn1')).be.true();
  });

  it('should memoize large values (gzip)', async () => {
    let callCount = 0;
    const functionToMemoize = async (val1) => {
      callCount++;
      return pkgJSON + val1;
    };
    const memoized = memoize(functionToMemoize, {name: 'pkg'});

    const json = await memoized(1);
    json.should.equal(pkgJSON + 1);
    callCount.should.equal(1);

    const json2 = await memoized(1);
    json2.should.equal(pkgJSON + 1);
    callCount.should.equal(1);
  });

  it('should memoize separate function separately', async () => {
    const function1 = async arg => { await Promise.delay(10); return 1; };
    const function2 = async arg => { await Promise.delay(10); return 2; };

    const memoizedFn1 = memoize(function1, {name: 'fn1'});
    const memoizedFn2 = memoize(function2, {name: 'fn2'});

    (await memoizedFn1('x')).should.equal(1);
    (await memoizedFn2('y')).should.equal(2);
    (await memoizedFn1('x')).should.equal(1);
  });

  it('should memoize same function with different args separately', async () => {
    const fn = async arg => { await Promise.delay(10); return arg; };

    const memoizedFn = memoize(fn, {name: 'fn_args'});

    (await memoizedFn('x')).should.equal('x');
    (await memoizedFn('y')).should.equal('y');
    (await memoizedFn('x')).should.equal('x');
  });

  async function stampede(options, memoizerOptions, memoizeOptions) {
    // this thing is crazy slow, breaks tests
    if (REDIS_TYP === 'fakeredis') return memoizerOptions.lock_retry_delay * 10;

    if (!options.delayTime || !options.iters) throw new Error('bad args', options);
    let callCount = 0;
    const do_memoize = memoizePkg(client, {
      ...makeDefaultOptions(),
      ...memoizerOptions,
    });

    const fn = async () => {
      callCount++;
      await Promise.delay(options.delayTime);
    };
    const memoized = do_memoize(fn, memoizeOptions);

    let start = Date.now();
    await Promise.all([ ...Array(options.iters).keys() ].map(() => memoized()));
    let duration = Date.now() - start;
    callCount.should.equal(1);
    return duration;
  }

  it('should prevent a cache stampede (slow lock)', async () => {
    const options = {delayTime: 10, iters: 10};
    const duration = await stampede(options, {lock_retry_delay: 50}, {name: 'fn_lock_slow'});
    (duration).should.be.above(options.delayTime * options.iters);
  });

  it('should prevent a cache stampede (fast lock)', async () => {
    const options = {delayTime: 10, iters: 10};
    const duration = await stampede(options, {lock_retry_delay: 1}, {name: 'fn_lock_fast'});
    (duration).should.be.below(options.delayTime * options.iters);
  });

  it('should prevent a cache stampede (low lock timeout)', async () => {
    const options = {delayTime: 10, iters: 10};
    const duration = await stampede(options, {lock_retry_delay: 1}, {name: 'fn_lock_fast2', lock_timeout: 20});
    (duration).should.be.below(50);
  });

  it(`should respect 'this'`, async () => {
    function Obj() { this.x = 1; }
    Obj.prototype.y = async function() {
      await Promise.delay(10);
      return this.x;
    };

    const obj = new Obj();
    const memoizedY = memoize(obj.y, {name: 'fn_this'}).bind(obj);

    (await memoizedY()).should.equal(1);
  });

  it('should respect the ttl', async () => {
    const ttl = 100;
    const functionDelayTime = 10;

    const fn = () => Promise.delay(functionDelayTime);
    const memoized = memoize(fn, {name: 'fn1', ttl});

    let start = Date.now();
    await memoized();
    (Date.now() - start >= functionDelayTime).should.be.true;

    // Call immediately again. Should be a cache hit.
    start = Date.now();
    await memoized();
    (Date.now() - start < functionDelayTime).should.be.true;

    // Wait some time, ttl should have expired
    await Promise.delay(ttl + 10);
    start = Date.now();
    await memoized();
    (Date.now() - start >= functionDelayTime).should.be.true;
  });

  it('should allow ttl to be a function', async () => {
    const functionDelayTime = 10;
    const ttl = 100;
    const fn = () => Promise.delay(functionDelayTime);
    const memoized = memoize(fn, {name: 'fn1', ttl: () => ttl});

    let start = Date.now();
    await memoized();
    (Date.now() - start >= functionDelayTime).should.be.true;

    // Call immediately again. Should be a cache hit
    start = Date.now();
    await memoized();
    (Date.now() - start <= functionDelayTime).should.be.true;

    // Wait some time, ttl should have expired;
    await Promise.delay(ttl + 10);

    start = Date.now();
    await memoized();
    (Date.now() - start >= functionDelayTime).should.be.true;
  });

  // FIXME this test is flaky when failing
  it('should gracefully fail lookup timeout', async () => {
    let counter = 0;
    const fn = () => counter++;
    const do_memoize = memoizePkg(client, {
      ...makeDefaultOptions(),
      lookup_timeout: -1,
    });

    const memoized = do_memoize(fn, {name: 'timeout_fn', ttl: 1000});

    // Hack to ensure this takes a while
    const gzipOrig = memoizePkg.gzip;
    memoizePkg.gzip = async function(value) {
      await Promise.delay(10);
      return value;
    };

    const res = await memoized();
    res.should.equal(0);
    const res2 = await memoized();
    res2.should.equal(1); // bc we didn't end up going to redis

    // Restore
    memoizePkg.gzip = gzipOrig;
  });

  it('should work if complex types are accepted and returned', async () => {
    const functionDelayTime = 10;
    const fn = async (arg1) => {
      await Promise.delay(functionDelayTime);
      return { arg1, some: ['other', 'data'] };
    };

    const memoized = memoize(fn, {name: 'fn1'});

    let start = Date.now();
    let { arg1, some } = await memoized({ input: 'data' });
    (Date.now() - start >= functionDelayTime).should.be.true;
    arg1.should.eql({ input: 'data' });
    some.should.eql(['other', 'data']);

    start = Date.now();
    ({ arg1, some } = await memoized({ input: 'data' }));
    (Date.now() - start <= functionDelayTime).should.be.true;
    arg1.should.eql({ input: 'data' });
    some.should.eql(['other', 'data']);
  });

  it('should memoize even if result is falsy', async () => {
    await Promise.all([undefined, null, false, ''].map(async (falsyValue, i) => {
      let callCount = 0;
      const fn = async () => {
        callCount++;
        return falsyValue;
      };

      const memoized = memoize(fn, {name: 'falsy_fn' + i});

      (await memoized() === falsyValue).should.be.true;
      (await memoized() === falsyValue).should.be.true;  // Repeated, presumably cache-hit
      callCount.should.equal(1);  // Verify cache hit
    }));
  });

  it(`shouldn't memoize errors by default`, async () => {
    let callCount = 0;
    const fn = async () => {
      callCount++;
      throw new Error('Test error');
    };

    const memoized = memoize(fn, {name: 'fn1'});

    try {
      await memoized();
    } catch(e) {
      callCount.should.equal(1);
    }

    try {
      await memoized();
    } catch(e) {
      callCount.should.equal(2);
    }
  });

	it(`should restore Date objects, not strings`, async () => {
		const date1 = new Date("2000-01-01T00:00:00.000Z");
		const date2 = new Date("2000-01-02T00:00:00.000Z");

		const fn = async (arg1) => {
			await Promise.delay(500);
			return [arg1, date2];
		};
		const memoized = memoize(fn, {name: 'fn1'});

		let start = Date.now();
		let [val1, val2] = await memoized(date1);
		(Date.now() - start >= 500).should.be.true;
		val1.should.be.an.instanceOf(Date);
		val2.should.be.an.instanceOf(Date);
		val1.should.eql(date1);
		val2.should.eql(date2);

		start = Date.now();
		[val1, val2] = await memoized(date1);
		(Date.now() - start <= 100).should.be.true;
		val1.should.be.an.instanceOf(Date);
		val2.should.be.an.instanceOf(Date);
		val1.should.eql(date1);
		val2.should.eql(date2);
	});

	it('should memoize errors when indicated', async function() {
		let hits = 0;
		async function errorFunction() {
			hits++;
			if (hits === 1) throw new Error('Hit Error #' + hits);
		}

		const do_memoize = memoizePkg(client, {
      ...makeDefaultOptions(),
			memoize_errors_when: () => true,
		});

		const memoized = do_memoize(errorFunction, {name: 'fn1', ttl: 1000});
		await memoized().should.be.rejectedWith(Error, { message: 'Hit Error #1' });
		await memoized().should.be.rejectedWith(Error, { message: 'Hit Error #1' });
	});

	it('should not memoize errors that are filtered out', async function() {
		let hits = 0;
		function errorFunction() {
			hits++;
			if (hits === 1) throw new Error('Hit Error!');
			else if (hits === 2) throw new Error('Special Error!');
			return hits;
		}

		const do_memoize = memoizePkg(client, {
      ...makeDefaultOptions(),
			memoize_errors_when: function(err) {
				return err.message !== 'Hit Error!';
			}
		});

		// First error won't be memoized, so expect hits to increment on subsequent calls.
		// Second error will, so hits will freeze there.
		const memoized = do_memoize(errorFunction, {name: 'fn2', ttl: 1000});
		await memoized().should.be.rejectedWith(Error, { message: 'Hit Error!' });
		hits.should.eql(1);

		await memoized().should.be.rejectedWith(Error, { message: 'Special Error!' });
		hits.should.eql(2);

		// Should stick here as it was memoized
		await memoized().should.be.rejectedWith(Error, { message: 'Special Error!' });
		hits.should.eql(2);
	});

	it('should not memoize two identical-looking functions to the same key', async function() {
		const funcA = (function() {
			const a = 10;
			return async () => a;
		})();
    funcA._name = 'a';
		const funcB = (function() {
			const a = 20;
			return async () => a;
		})();
    funcB._name = 'b';

		const memoizedA = memoize(funcA, {});
		const memoizedB = memoize(funcB, {});
		const result1 = await memoizedA();
		result1.should.eql(10);

		const result2 = await memoizedB();
		result2.should.eql(20);
	});

  it('Should allow overriding error_serialization_keys', async function() {
    let counter = 0;
    async function funcA() {
      const err = new Error('wat');
      err.foo = counter++;
      throw err;
    }

    const do_memoize = memoizePkg(client, {
      ...makeDefaultOptions(),
      memoize_errors_when: function(err) {
        return true;
      },
      error_serialization_keys: ['message', 'foo']
    });

    const memoizedA = do_memoize(funcA, {name: 'err_reviver', ttl: 10000});

    async function verify() {
      try {
        await memoizedA();
      } catch (e) {
        e.message.should.eql('wat');
        e.foo.should.eql(0);
      }
    }
    await verify();
    await verify();
  });

  it('Should allow overriding serialize_value', async function() {
    let counter = 0;
    async function funcA() {
      return counter++;
    }

    const do_memoize = memoizePkg(client, {
      ...makeDefaultOptions(),
      serialize_value(value, options) {
        return `"foo${value}"`;
      },
    });

    const memoizedA = do_memoize(funcA, {name: 'err_reviver', ttl: 10000});

    const value = await memoizedA();
    value.should.eql(0);
    const value2 = await memoizedA();
    value2.should.eql('foo0');
  });

  it('Should allow overriding deserialize_value', async function() {
    let counter = 0;
    async function funcA() {
      return counter++;
    }

    const do_memoize = memoizePkg(client, {
      ...makeDefaultOptions(),
      deserialize_value(value, options) {
        return `bar${value}`;
      },
    });

    const memoizedA = do_memoize(funcA, {name: 'err_reviver', ttl: 10000});

    const value = await memoizedA();
    value.should.eql(0);
    const value2 = await memoizedA();
    value2.should.eql('bar0');
  });
});
